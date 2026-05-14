import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import {
  canServeGatewayRequest,
  describeGatewayHealth,
} from "./gateway-readiness.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line);

  logRingBuffer.push(line);
  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"));
    }
  } catch {}
}

const log = {
  info: (category, message) => writeLog("INFO", category, message),
  warn: (category, message) => writeLog("WARN", category, message),
  error: (category, message) => writeLog("ERROR", category, message),
};

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    log.warn("gateway-token", `could not read existing token: ${err.code || err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("gateway-token", `could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    cachedOpenclawVersion = version.output.trim();
  }
  return { version: cachedOpenclawVersion };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
// This is the wrapper's upstream target host, not an OpenClaw --bind mode.
// Railway exposes the Express wrapper on PORT; the gateway stays private.
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function stripAnsi(value) {
  return String(value)
    .replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, "")
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "");
}

function isTransientProgressLine(line) {
  return /^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏.-]*(Requesting device code|Waiting for device authorization|Exchanging device code)/.test(
    line,
  );
}

function cleanPtyOutput(value) {
  const cleaned = stripAnsi(value)
    .split(/\r|\n/)
    .filter((line) => line && !isTransientProgressLine(line))
    .join("\n");
  return cleaned ? `${cleaned}\n` : "";
}

let deviceBootstrapSdkPromise = null;

function resolveDeviceBootstrapSdkPath() {
  const entryPath = path.resolve(OPENCLAW_ENTRY);
  try {
    const requireFromOpenclaw = createRequire(entryPath);
    return requireFromOpenclaw.resolve("openclaw/plugin-sdk/device-bootstrap");
  } catch {
    const openclawRoot = path.dirname(path.dirname(entryPath));
    return path.join(openclawRoot, "dist", "plugin-sdk", "device-bootstrap.js");
  }
}

async function loadDeviceBootstrapSdk() {
  if (!deviceBootstrapSdkPromise) {
    deviceBootstrapSdkPromise = import(
      pathToFileURL(resolveDeviceBootstrapSdkPath()).href
    ).catch((err) => {
      deviceBootstrapSdkPromise = null;
      throw err;
    });
  }
  return deviceBootstrapSdkPromise;
}

async function probeDeviceBootstrapSdk() {
  try {
    await loadDeviceBootstrapSdk();
    log.info(
      "devices",
      `device bootstrap SDK ready: ${resolveDeviceBootstrapSdkPath()}`,
    );
  } catch (err) {
    log.warn(
      "devices",
      `device bootstrap SDK unavailable at startup (${resolveDeviceBootstrapSdkPath()}): ${err?.message || String(err)}`,
    );
  }
}

function devicePairingTimestamp(request) {
  const ts = request?.ts;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function newestPendingDevicePairing(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return null;
  return pending.reduce((latest, current) =>
    devicePairingTimestamp(current) > devicePairingTimestamp(latest)
      ? current
      : latest,
  );
}

function describeDeviceApprovalForbidden(result) {
  const scope = result?.scope || "unknown";
  const role = result?.role || "unknown";

  switch (result?.reason) {
    case "caller-scopes-required":
      return `missing scope: ${scope}`;
    case "caller-missing-scope":
      return `missing scope: ${scope}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${scope}`;
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${role}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${scope}`;
    default:
      return "Device approval is forbidden by bootstrap policy.";
  }
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;

  const current = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "get", "gateway.controlUi.allowedOrigins"]),
  );
  if (current.code === 0 && current.output.includes(origin)) {
    return;
  }

  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    log.info("gateway", `set allowedOrigins to [${origin}]`);
  } else {
    log.warn("gateway", `failed to set allowedOrigins (exit=${result.code})`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;
let gatewayRestartCount = 0;
let gatewayLastStartTime = 0;
let intentionalRestart = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeGatewayOnce(opts = {}) {
  const endpoints = ["/openclaw", "/", "/health"];
  const timeoutMs = opts.timeoutMs ?? 2000;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
        method: "GET",
        signal: controller.signal,
      });
      if (res.status < 500) {
        return { ok: true, endpoint };
      }
    } catch (err) {
      if (
        err.name !== "AbortError" &&
        err.code !== "ECONNREFUSED" &&
        err.cause?.code !== "ECONNREFUSED"
      ) {
        const msg = err.code || err.message;
        if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
          log.warn("gateway", `health check error: ${msg}`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, endpoint: null };
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = await probeGatewayOnce();
    if (probe.ok) {
      log.info("gateway", `ready at ${probe.endpoint}`);
      return true;
    }
    await sleep(250);
  }
  log.error("gateway", `failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("gateway", `stop existing gateway exit=${stopResult.code}`);

  const args = [
    "gateway",
    "run",
    "--bind",
    // Intentional for Railway: only the wrapper is public, and it proxies to the
    // gateway over loopback while injecting auth.
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayLastStartTime = Date.now();
  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  log.info("gateway", `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);
  log.info("gateway", `STATE_DIR: ${STATE_DIR}`);
  log.info("gateway", `WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  log.info("gateway", `config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    log.error("gateway", `spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    log.error("gateway", `exited code=${code} signal=${signal}`);
    const uptime = Date.now() - gatewayLastStartTime;
    gatewayProc = null;
    if (!shuttingDown && !intentionalRestart && isConfigured()) {
      if (uptime > 30_000) {
        gatewayRestartCount = 0;
      } else {
        gatewayRestartCount++;
      }
      const delay = Math.min(2000 * Math.pow(2, gatewayRestartCount), 60_000);
      log.info("gateway", `scheduling auto-restart in ${delay / 1000}s (attempt ${gatewayRestartCount}, uptime ${Math.round(uptime / 1000)}s)...`);
      setTimeout(async () => {
        if (shuttingDown || gatewayProc || !isConfigured()) {
          return;
        }

        const probe = await probeGatewayOnce();
        if (probe.ok) {
          log.info(
            "gateway",
            `gateway still reachable at ${probe.endpoint}; assuming OpenClaw restarted itself`,
          );
          gatewayRestartCount = 0;
          return;
        }

        ensureGatewayRunning().catch((err) => {
          log.error("gateway", `auto-restart failed: ${err.message}`);
        });
      }, delay);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  const probe = await probeGatewayOnce();
  if (probe.ok) {
    return { ok: true, reason: "reachable" };
  }
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    intentionalRestart = true;
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gateway", `kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
    intentionalRestart = false;
  }
  await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  gatewayRestartCount = 0;
  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/healthz", async (_req, res) => {
  const configured = isConfigured();
  const health = describeGatewayHealth({
    configured,
    hasProcessHandle: isGatewayReady(),
    starting: isGatewayStarting(),
    reachable: configured ? (await probeGatewayOnce()).ok : false,
  });
  res.json({ ok: true, gateway: health.gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const health = describeGatewayHealth({
    configured,
    hasProcessHandle: isGatewayReady(),
    starting: isGatewayStarting(),
    reachable: configured ? (await probeGatewayOnce()).ok : false,
  });

  res.status(health.statusCode).json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning: health.gatewayRunning,
    gatewayStarting: health.gatewayStarting,
    gatewayReachable: health.gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/config", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "config.html"));
});

app.get("/setup/api/config/raw", requireSetupAuth, (_req, res) => {
  const p = configPath();
  const exists = fs.existsSync(p);
  const content = exists ? fs.readFileSync(p, "utf8") : "";
  res.json({ ok: true, path: p, exists, content });
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  const content = String((req.body && req.body.content) || "");
  if (content.length > 500_000) {
    return res
      .status(413)
      .json({ ok: false, error: "Config too large (max 500KB)" });
  }
  try {
    JSON.parse(content);
  } catch (err) {
    return res
      .status(400)
      .json({ ok: false, error: `Invalid JSON: ${err.message}` });
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const p = configPath();
  let backupPath = null;
  if (fs.existsSync(p)) {
    backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(p, backupPath);
  }

  // Write to a sibling tmp file then renameSync over the live config so a
  // crash or disk-full mid-write can't leave openclaw.json truncated.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return res
      .status(500)
      .json({ ok: false, error: `Failed to write config: ${err.message}` });
  }

  let restarted = false;
  if (isConfigured()) {
    await restartGateway();
    restarted = true;
  }
  res.json({ ok: true, path: p, backupPath, restarted });
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "API key",
      options: [
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "openai",
      label: "OpenAI",
      hint: "API key / Codex",
      options: [
        { value: "openai-api-key", label: "OpenAI API key" },
        {
          value: "openai-codex-device-code",
          label: "OpenAI Codex device pairing",
          hint: "ChatGPT login without an API key",
        },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "API key / CLI",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-gemini-cli", label: "Google Gemini CLI (OAuth)" },
      ],
    },
    {
      value: "deepseek",
      label: "DeepSeek",
      hint: "API key",
      options: [
        { value: "deepseek-api-key", label: "DeepSeek API key" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "xai",
      label: "xAI (Grok)",
      hint: "API key",
      options: [{ value: "xai-api-key", label: "xAI API key" }],
    },
    {
      value: "mistral",
      label: "Mistral AI",
      hint: "API key",
      options: [{ value: "mistral-api-key", label: "Mistral API key" }],
    },
    {
      value: "together",
      label: "Together AI",
      hint: "API key",
      options: [{ value: "together-api-key", label: "Together AI API key" }],
    },
    {
      value: "huggingface",
      label: "Hugging Face",
      hint: "API key",
      options: [{ value: "huggingface-api-key", label: "Hugging Face API key" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "moonshot-api-key-cn", label: "Moonshot AI API key (CN)" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "API key / OAuth",
      options: [
        { value: "minimax-global-api", label: "MiniMax API key (Global)" },
        { value: "minimax-global-oauth", label: "MiniMax OAuth (Global)" },
        { value: "minimax-cn-api", label: "MiniMax API key (CN)" },
        { value: "minimax-cn-oauth", label: "MiniMax OAuth (CN)" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key / OAuth",
      options: [
        { value: "zai-api-key", label: "Z.AI API key" },
        { value: "zai-coding-global", label: "Z.AI Coding (Global)" },
        { value: "zai-coding-cn", label: "Z.AI Coding (CN)" },
        { value: "zai-global", label: "Z.AI (Global)" },
        { value: "zai-cn", label: "Z.AI (CN)" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "modelstudio",
      label: "Alibaba Model Studio",
      hint: "Qwen via Alibaba Cloud",
      options: [
        { value: "modelstudio-api-key", label: "Coding Plan (Global)" },
        { value: "modelstudio-api-key-cn", label: "Coding Plan (CN)" },
        { value: "modelstudio-standard-api-key", label: "Standard Plan (Global)" },
        { value: "modelstudio-standard-api-key-cn", label: "Standard Plan (CN)" },
      ],
    },
    {
      value: "venice",
      label: "Venice AI",
      hint: "API key",
      options: [{ value: "venice-api-key", label: "Venice AI API key" }],
    },
    {
      value: "chutes",
      label: "Chutes",
      hint: "OAuth / API key",
      options: [
        { value: "chutes", label: "Chutes OAuth" },
        { value: "chutes-api-key", label: "Chutes API key" },
      ],
    },
    {
      value: "kilocode",
      label: "Kilocode",
      hint: "API key",
      options: [{ value: "kilocode-api-key", label: "Kilocode API key" }],
    },
    {
      value: "xiaomi",
      label: "Xiaomi",
      hint: "API key",
      options: [{ value: "xiaomi-api-key", label: "Xiaomi API key" }],
    },
    {
      value: "volcengine",
      label: "Volcano Engine (Doubao)",
      hint: "API key",
      options: [{ value: "volcengine-api-key", label: "Volcano Engine API key" }],
    },
    {
      value: "byteplus",
      label: "BytePlus",
      hint: "API key",
      options: [{ value: "byteplus-api-key", label: "BytePlus API key" }],
    },
    {
      value: "qianfan",
      label: "Qianfan (Baidu)",
      hint: "API key",
      options: [{ value: "qianfan-api-key", label: "Qianfan API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "cloudflare-ai-gateway",
      label: "Cloudflare AI Gateway",
      hint: "API key",
      options: [
        { value: "cloudflare-ai-gateway-api-key", label: "Cloudflare AI Gateway API key" },
      ],
    },
    {
      value: "litellm",
      label: "LiteLLM",
      hint: "Unified gateway",
      options: [{ value: "litellm-api-key", label: "LiteLLM API key" }],
    },
    {
      value: "opencode",
      label: "OpenCode",
      hint: "Zen / Go",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
        { value: "opencode-go", label: "OpenCode Go" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "self-hosted",
      label: "Self-hosted",
      hint: "Ollama / vLLM / SGLang",
      options: [
        { value: "ollama", label: "Ollama (local)" },
        { value: "vllm", label: "vLLM" },
        { value: "sglang", label: "SGLang" },
      ],
    },
    {
      value: "custom",
      label: "Custom endpoint",
      hint: "OpenAI / Anthropic compatible",
      options: [{ value: "custom-api-key", label: "Custom provider" }],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

function requiresInteractiveOnboarding(payload) {
  return payload.authChoice === "openai-codex-device-code";
}

function buildOnboardArgs(payload) {
  const interactive = requiresInteractiveOnboarding(payload);
  const args = [
    "onboard",
    "--accept-risk",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    "quickstart",
  ];

  if (interactive) {
    args.push(
      "--mode",
      "local",
      "--skip-channels",
      "--skip-skills",
      "--skip-search",
      "--skip-ui",
    );
  } else {
    args.push("--non-interactive", "--json");
  }

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      apiKey: "--anthropic-api-key",
      "openai-api-key": "--openai-api-key",
      "gemini-api-key": "--gemini-api-key",
      "deepseek-api-key": "--deepseek-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "xai-api-key": "--xai-api-key",
      "mistral-api-key": "--mistral-api-key",
      "together-api-key": "--together-api-key",
      "huggingface-api-key": "--huggingface-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "moonshot-api-key-cn": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "minimax-global-api": "--minimax-api-key",
      "minimax-cn-api": "--minimax-api-key",
      "zai-api-key": "--zai-api-key",
      "modelstudio-api-key": "--modelstudio-api-key",
      "modelstudio-api-key-cn": "--modelstudio-api-key-cn",
      "modelstudio-standard-api-key": "--modelstudio-standard-api-key",
      "modelstudio-standard-api-key-cn": "--modelstudio-standard-api-key-cn",
      "venice-api-key": "--venice-api-key",
      "chutes-api-key": "--chutes-api-key",
      "kilocode-api-key": "--kilocode-api-key",
      "xiaomi-api-key": "--xiaomi-api-key",
      "volcengine-api-key": "--volcengine-api-key",
      "byteplus-api-key": "--byteplus-api-key",
      "qianfan-api-key": "--qianfan-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "cloudflare-ai-gateway-api-key": "--cloudflare-ai-gateway-api-key",
      "litellm-api-key": "--litellm-api-key",
      "opencode-zen": "--opencode-zen-api-key",
      "opencode-go": "--opencode-go-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "custom-api-key": "--custom-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "custom-api-key") {
      const baseUrl = (payload.customBaseUrl || "").trim();
      const modelId = (payload.customModelId || "").trim();
      const compat = (payload.customCompatibility || "").trim();
      if (baseUrl) args.push("--custom-base-url", baseUrl);
      if (modelId) args.push("--custom-model-id", modelId);
      if (compat) args.push("--custom-compatibility", compat);
    }

    if (payload.authChoice === "cloudflare-ai-gateway-api-key") {
      const accountId = (payload.cloudflareAccountId || "").trim();
      const gatewayId = (payload.cloudflareGatewayId || "").trim();
      if (accountId) args.push("--cloudflare-ai-gateway-account-id", accountId);
      if (gatewayId) args.push("--cloudflare-ai-gateway-gateway-id", gatewayId);
    }

  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { autoInputs: _autoInputs, onOutput, stripOutput, ...spawnOpts } = opts;
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    const append = (d) => {
      const rawChunk = d.toString("utf8");
      const streamChunk = stripOutput ? stripAnsi(rawChunk) : rawChunk;
      out += rawChunk;
      onOutput?.(streamChunk);
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

function runPtyCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    const autoInputs = opts.autoInputs ?? [];
    const sentAutoInputs = new Set();
    let proc;
    try {
      proc = pty.spawn(cmd, args, {
        name: "xterm-color",
        cols: 100,
        rows: 30,
        cwd: opts.cwd ?? process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          // Force OpenClaw's local device-code branch so Railway setup can show
          // the short code in the web UI instead of hiding it as remote-only.
          DISPLAY: process.env.DISPLAY || ":0",
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
          SSH_CLIENT: "",
          SSH_TTY: "",
          SSH_CONNECTION: "",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      });
    } catch (err) {
      out += `\n[spawn error] ${String(err)}\n`;
      opts.onOutput?.(out);
      resolve({ code: 127, output: out });
      return;
    }

    proc.onData((data) => {
      const chunk = opts.cleanOutput ? cleanPtyOutput(data) : stripAnsi(data);
      if (!chunk) return;
      out += chunk;
      for (const { input, pattern } of autoInputs) {
        const key = String(pattern);
        if (sentAutoInputs.has(key) || !pattern.test(out)) continue;
        sentAutoInputs.add(key);
        proc.write(input);
      }
      opts.onOutput?.(chunk);
    });

    proc.onExit(({ exitCode }) => {
      resolve({ code: exitCode ?? 0, output: out });
    });
  });
}

const VALID_AUTH_CHOICES = [
  "apiKey",
  "openai-api-key",
  "openai-codex",
  "openai-codex-device-code",
  "gemini-api-key",
  "google-gemini-cli",
  "deepseek-api-key",
  "openrouter-api-key",
  "xai-api-key",
  "mistral-api-key",
  "together-api-key",
  "huggingface-api-key",
  "github-copilot",
  "copilot-proxy",
  "moonshot-api-key",
  "moonshot-api-key-cn",
  "kimi-code-api-key",
  "minimax-global-api",
  "minimax-global-oauth",
  "minimax-cn-api",
  "minimax-cn-oauth",
  "zai-api-key",
  "zai-coding-global",
  "zai-coding-cn",
  "zai-global",
  "zai-cn",
  "qwen-portal",
  "modelstudio-api-key",
  "modelstudio-api-key-cn",
  "modelstudio-standard-api-key",
  "modelstudio-standard-api-key-cn",
  "venice-api-key",
  "chutes",
  "chutes-api-key",
  "kilocode-api-key",
  "xiaomi-api-key",
  "volcengine-api-key",
  "byteplus-api-key",
  "qianfan-api-key",
  "ai-gateway-api-key",
  "cloudflare-ai-gateway-api-key",
  "litellm-api-key",
  "opencode-zen",
  "opencode-go",
  "synthetic-api-key",
  "ollama",
  "vllm",
  "sglang",
  "custom-api-key",
];

function validatePayload(payload) {
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  if (payload.authChoice === "openai-codex") {
    return "OpenAI Codex browser login needs redirect-url input in an interactive terminal. Choose OpenAI Codex device pairing in web setup.";
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
    "customBaseUrl",
    "customModelId",
    "customCompatibility",
    "cloudflareAccountId",
    "cloudflareGatewayId",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  const stream = (chunk) => {
    if (chunk) res.write(chunk);
  };

  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res
        .type("text/plain")
        .send("Already configured.\nUse Reset setup if you want to rerun onboarding.\n");
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).type("text/plain").send(`${validationError}\n`);
    }

    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    const onboardArgs = buildOnboardArgs(payload);
    const interactive = requiresInteractiveOnboarding(payload);
    stream(
      interactive
        ? "Starting OpenAI Codex device pairing. Use the URL and code below, then keep this page open until it completes.\n\n"
        : "Starting OpenClaw onboarding...\n\n",
    );

    const onboardRunner = interactive ? runPtyCmd : runCmd;
    const onboard = await onboardRunner(OPENCLAW_NODE, clawArgs(onboardArgs), {
      onOutput: stream,
      cleanOutput: interactive,
      stripOutput: !interactive,
      autoInputs: interactive ? [{ pattern: /Enable hooks\?/, input: " \r" }] : [],
    });

    const ok = onboard.code === 0 && isConfigured();
    stream(`\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`);

    if (ok) {
      stream("\n[setup] Configuring gateway settings...\n");

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      stream(
        `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`,
      );

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      stream(`[config] gateway.auth.token exit=${tokenResult.code}\n`);

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      stream(`[config] gateway.trustedProxies exit=${proxiesResult.code}\n`);

      if (payload.model?.trim()) {
        stream(`[setup] Setting model to ${payload.model.trim()}...\n`);
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
          { onOutput: stream, stripOutput: true },
        );
        stream(`[models set] exit=${modelResult.code}\n`);
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        stream(
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
            `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}\n`,
        );
      }

      if (payload.telegramToken?.trim()) {
        await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "open",
          streaming: { mode: "partial" },
        });
      }

      if (payload.discordToken?.trim()) {
        await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "open",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      stream("\n[setup] Starting gateway...\n");
      await restartGateway();
      stream("[setup] Gateway started.\n");
    }

    stream(ok ? "\n[setup] Complete.\n" : "\n[setup] Failed. Review the output above.\n");
    return res.end();
  } catch (err) {
    log.error("setup", `run error: ${String(err)}`);
    if (!res.headersSent) {
      return res.status(500).type("text/plain").send(`Internal error: ${String(err)}\n`);
    }
    stream(`\n[setup] Internal error: ${String(err)}\n`);
    return res.end();
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  const channelValue = String(channel || "").trim().toLowerCase();
  const codeValue = String(code || "").trim();
  if (!channelValue || !codeValue) {
    return res
      .status(400)
      .json({
        ok: false,
        code: "invalid_request",
        message: "Choose a channel and enter a pairing code.",
        error: "Missing channel or code",
      });
  }
  if (!["telegram", "discord"].includes(channelValue)) {
    return res.status(400).json({
      ok: false,
      code: "invalid_channel",
      message: "Channel must be Telegram or Discord.",
      error: `Invalid channel: ${channelValue}`,
    });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", channelValue, codeValue]),
  );
  const output = r.output || "";
  const cleanOutput = stripAnsi(output);

  if (r.code === 0) {
    return res.status(200).json({
      ok: true,
      code: "approved",
      message: "Channel access approved.",
      output,
    });
  }

  if (/no pending pairing request/i.test(cleanOutput)) {
    return res.status(404).json({
      ok: false,
      code: "no_pending_request",
      message:
        "No pending request matched that code. It may already be approved, expired, or replaced by a newer code.",
      output,
    });
  }

  return res.status(500).json({
    ok: false,
    code: "pairing_failed",
    message: "Channel approval failed. Review the log output for details.",
    output,
  });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    if (gatewayProc) {
      intentionalRestart = true;
      gatewayProc.kill("SIGTERM");
      await sleep(750);
      gatewayProc = null;
      intentionalRestart = false;
    }
    await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - stopped gateway and deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  try {
    const { listDevicePairing } = await loadDeviceBootstrapSdk();
    const data = await listDevicePairing();
    log.info(
      "devices",
      `local list pending=${data?.pending?.length ?? 0} paired=${data?.paired?.length ?? 0}`,
    );
    return res.json({ ok: true, data });
  } catch (err) {
    const message = err?.message || String(err);
    log.warn("devices", `local list failed: ${message}`);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String(req.body?.requestId || "").trim();

  try {
    const { approveDevicePairing, listDevicePairing } =
      await loadDeviceBootstrapSdk();
    const pairings = await listDevicePairing();
    const pending = Array.isArray(pairings?.pending) ? pairings.pending : [];

    let targetRequestId = requestId;
    if (targetRequestId) {
      const exists = pending.some(
        (request) => request?.requestId === targetRequestId,
      );
      if (!exists) {
        return res.status(404).json({
          ok: false,
          error: `Unknown pending device pairing request: ${targetRequestId}`,
        });
      }
    } else {
      const latest = newestPendingDevicePairing(pending);
      targetRequestId = latest?.requestId || "";
      if (!targetRequestId) {
        return res.status(404).json({
          ok: false,
          error: "No pending device pairing requests.",
        });
      }
    }

    const result = await approveDevicePairing(targetRequestId, {
      // /setup is guarded by SETUP_PASSWORD and runs in the same state volume
      // as the gateway, so it acts as the trusted bootstrap admin surface.
      callerScopes: ["operator.admin"],
    });

    if (!result) {
      return res.status(404).json({
        ok: false,
        error: `Unknown pending device pairing request: ${targetRequestId}`,
      });
    }

    if (result.status === "forbidden") {
      return res.status(403).json({
        ok: false,
        error: describeDeviceApprovalForbidden(result),
        reason: result.reason,
      });
    }

    return res.json({
      ok: true,
      requestId: targetRequestId,
      device: result.device,
      output: `Approved device pairing request ${targetRequestId}.`,
    });
  } catch (err) {
    const message = err?.message || String(err);
    log.error("devices", `local approve failed: ${message}`);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/setup/api/devices/reject", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }
  // TODO: switch this to the bootstrap SDK once rejectDevicePairing is exported
  // from openclaw/plugin-sdk/device-bootstrap.
  const args = [
    "devices", "reject", String(requestId),
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.get("/setup/api/export", requireSetupAuth, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipName = `openclaw-export-${timestamp}.zip`;
  const tmpZip = path.join(os.tmpdir(), zipName);

  try {
    const dirsToExport = [];
    if (fs.existsSync(STATE_DIR)) dirsToExport.push(STATE_DIR);
    if (fs.existsSync(WORKSPACE_DIR)) dirsToExport.push(WORKSPACE_DIR);

    if (dirsToExport.length === 0) {
      return res.status(404).json({ ok: false, error: "No data directories found to export." });
    }

    const zipArgs = ["-r", "-P", SETUP_PASSWORD, tmpZip, ...dirsToExport];
    const result = await runCmd("zip", zipArgs);

    if (result.code !== 0 || !fs.existsSync(tmpZip)) {
      return res.status(500).json({ ok: false, error: "Failed to create export archive.", output: result.output });
    }

    const stat = fs.statSync(tmpZip);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(stat.size),
    });

    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    });
    stream.on("error", (err) => {
      log.error("export", `stream error: ${err.message}`);
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Stream error during export." });
      }
    });
  } catch (err) {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    log.error("export", `error: ${err.message}`);
    return res.status(500).json({ ok: false, error: `Export failed: ${err.message}` });
  }
});

app.post(
  "/setup/api/import",
  requireSetupAuth,
  express.raw({ type: "application/zip", limit: "250mb" }),
  async (req, res) => {
    const dataRoot = "/data";
    const isUnder = (p) => {
      const abs = path.resolve(p);
      return abs === dataRoot || abs.startsWith(dataRoot + path.sep);
    };

    if (!isUnder(STATE_DIR) || !isUnder(WORKSPACE_DIR)) {
      return res.status(400).json({
        ok: false,
        error: "Import only supported when state/workspace dirs are under /data.",
      });
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty or invalid request body." });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const tmpZip = path.join(dataRoot, `.import-${ts}.zip`);
    const tmpExtract = path.join(dataRoot, `.import-extract-${ts}`);
    const stateAbs = path.resolve(STATE_DIR);
    const workspaceAbs = path.resolve(WORKSPACE_DIR);
    // Archive entries are stored relative — `zip` strips the leading "/" from
    // absolute paths it was given, so /data/.openclaw becomes data/.openclaw.
    const stateRel = stateAbs.replace(/^\//, "");
    const workspaceRel = workspaceAbs.replace(/^\//, "");
    const allowedPrefixes = [stateRel, workspaceRel];
    const cleanup = () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
    };

    let archivePassword = SETUP_PASSWORD;
    const headerPw = req.get("x-archive-password");
    if (headerPw) {
      try {
        const decoded = Buffer.from(headerPw, "base64").toString("utf8").trim();
        if (decoded) archivePassword = decoded;
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Invalid X-Archive-Password header.",
        });
      }
    }

    const reject = (status, error, extra = {}) => {
      const e = new Error(error);
      e.status = status;
      e.extra = extra;
      return e;
    };
    const walkRejectSymlinks = (dir) => {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        const rel = path.relative(tmpExtract, dir) || path.basename(dir);
        throw reject(400, `Refusing symlink in archive: ${rel}`);
      }
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(dir)) {
          walkRejectSymlinks(path.join(dir, name));
        }
        return;
      }
      if (!st.isFile()) {
        const rel = path.relative(tmpExtract, dir) || path.basename(dir);
        throw reject(400, `Refusing non-regular entry in archive: ${rel}`);
      }
    };

    const backups = [];
    let gatewayWasStopped = false;
    try {
      fs.writeFileSync(tmpZip, buf);

      // Pre-validate every archive entry. Reject anything that isn't under one
      // of the configured state/workspace prefixes — the archive is gated by
      // SETUP_PASSWORD but we never want a malformed or hand-crafted backup to
      // write outside /data.
      // -Z (ZipInfo) doesn't accept -P; entry names aren't encrypted so we
      // don't need the password just to list them.
      const list = await runCmd("unzip", ["-Z1", tmpZip]);
      if (list.code !== 0) {
        throw reject(
          400,
          "Failed to read archive. Check the file and that SETUP_PASSWORD matches.",
          { output: list.output },
        );
      }
      const entries = list.output.split("\n").map((s) => s.trim()).filter(Boolean);
      const entryAllowed = (e) => {
        if (e.startsWith("/") || /^[A-Za-z]:[\\/]/.test(e)) return false;
        const norm = e.replace(/\\/g, "/").replace(/\/+$/, "");
        if (norm.split("/").includes("..")) return false;
        return allowedPrefixes.some((p) => norm === p || norm.startsWith(p + "/"));
      };
      const bad = entries.filter((e) => !entryAllowed(e));
      if (bad.length) {
        throw reject(
          400,
          `Archive contains ${bad.length} entries outside ${STATE_DIR} / ${WORKSPACE_DIR}. ` +
            `First few: ${bad.slice(0, 3).join(", ")}`,
        );
      }

      // Extract into a sibling directory under /data so renames into
      // STATE_DIR / WORKSPACE_DIR are intra-volume (atomic on POSIX).
      // We extract BEFORE stopping the gateway so a wrong password or
      // corrupt archive doesn't cost the user any gateway downtime.
      fs.mkdirSync(tmpExtract, { recursive: true });
      const extractResult = await runCmd("unzip", ["-P", archivePassword, "-o", tmpZip, "-d", tmpExtract]);
      if (extractResult.code !== 0) {
        log.error("import", `unzip exit ${extractResult.code}: ${extractResult.output}`);
        // unzip exit 82 = wrong password; 81 = needs password but none given.
        if (extractResult.code === 82 || extractResult.code === 81) {
          throw reject(
            400,
            headerPw
              ? "Incorrect archive password."
              : "Incorrect archive password. If this backup was exported from another instance, supply that instance's SETUP_PASSWORD.",
          );
        }
        throw reject(500, "Failed to extract archive.", { output: extractResult.output });
      }

      // unzip can restore symlinks (zip -y) and other non-regular entries that
      // would let a crafted archive smuggle e.g. data/.openclaw → /etc. Walk
      // the extracted tree with lstat and reject anything that isn't a plain
      // dir or file before we move it into place.
      walkRejectSymlinks(tmpExtract);

      // Replace each target dir wholesale: rename target → backup, then move
      // extracted dir into place. Skips dirs absent from the backup so a
      // partial archive doesn't wipe an unrelated dir.
      const replacements = [
        { target: stateAbs, source: path.join(tmpExtract, stateRel) },
        { target: workspaceAbs, source: path.join(tmpExtract, workspaceRel) },
      ];

      // Even after walkRejectSymlinks, the entry at the source path itself
      // could be a regular file masquerading as data/.openclaw. Require an
      // actual directory before swapping it in for STATE_DIR / WORKSPACE_DIR.
      // Run this validation BEFORE stopping the gateway so a malformed
      // archive doesn't cost any downtime.
      const validReplacements = [];
      for (const r of replacements) {
        if (!fs.existsSync(r.source)) continue;
        if (!fs.lstatSync(r.source).isDirectory()) {
          throw reject(
            400,
            `Archive entry ${path.relative(tmpExtract, r.source)} is not a directory.`,
          );
        }
        validReplacements.push(r);
      }

      // Now that the archive is fully extracted and validated, take down the
      // gateway. From here through the rename swap, downtime is unavoidable.
      if (gatewayProc) {
        intentionalRestart = true;
        try {
          gatewayProc.kill("SIGTERM");
        } catch (err) {
          log.warn("import", `kill error: ${err.message}`);
        }
        await sleep(750);
        gatewayProc = null;
        intentionalRestart = false;
        gatewayWasStopped = true;
      }

      for (const { target, source } of validReplacements) {
        const backup = `${target}.bak-${ts}`;
        if (fs.existsSync(target)) {
          fs.renameSync(target, backup);
          backups.push({ target, backup });
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
      }

      for (const { backup } of backups) {
        try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
      }
      backups.length = 0;

      log.info("import", `restored ${buf.length} bytes from archive`);
      await restartGateway();
      return res.json({ ok: true, output: extractResult.output });
    } catch (err) {
      const status = err.status ?? 500;
      const extra = err.extra ?? {};
      if (status >= 500) log.error("import", `error: ${err.message}`);
      // Roll back any partial replacement.
      for (const { target, backup } of backups) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
        try { fs.renameSync(backup, target); } catch {}
      }
      if (gatewayWasStopped) await ensureGatewayRunning().catch(() => {});
      return res.status(status).json({ ok: false, error: err.message, ...extra });
    } finally {
      cleanup();
    }
  },
);

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/logs", requireSetupAuth, async (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const limit = Math.min(Number.parseInt(_req.query.lines ?? "500", 10), 5000);
    return res.json({ ok: true, lines: lines.slice(-limit) });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.json({ ok: true, lines: [] });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of logRingBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    log.info("tui", `session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      log.info("tui", `spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        log.info("tui", "max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info("tui", `PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        log.warn("tui", `invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log.info("tui", "session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      log.error("tui", `WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  log.error("proxy", String(err));
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  if (!req.url?.startsWith("/hooks/")) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

app.use(async (req, res) => {
  if (req.path === "/") {
    return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  }

  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      let gatewayReachable = false;
      try {
        await ensureGatewayRunning();
        gatewayReachable = (await probeGatewayOnce()).ok;
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (
        !canServeGatewayRequest({
          configured: true,
          reachable: gatewayReachable,
        })
      ) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  log.info("wrapper", `listening on port ${PORT}`);
  log.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  log.info("wrapper", `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  log.info("wrapper", `configured: ${isConfigured()}`);
  void probeDeviceBootstrapSdk();

  if (isConfigured()) {
    (async () => {
      try {
        log.info("wrapper", "running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        log.info("wrapper", `doctor --fix exit=${dr.code}`);
        if (dr.output) log.info("wrapper", dr.output);
      } catch (err) {
        log.warn("wrapper", `doctor --fix failed: ${err.message}`);
      }
      await ensureGatewayRunning();
    })().catch((err) => {
      log.error("wrapper", `failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    log.warn("websocket", `gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  log.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gateway: ${err.message}`);
    }
  }

  try {
    const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
    log.info("wrapper", `gateway stop during shutdown exit=${stopResult.code}`);
  } catch (err) {
    log.warn("wrapper", `gateway stop during shutdown failed: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
