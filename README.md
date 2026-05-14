# Deploy and Host OpenClaw on Railway

OpenClaw is an open-source personal AI assistant platform with 328,000+ GitHub stars that connects 20+ messaging apps — WhatsApp, Telegram, Discord, Slack, iMessage, Signal, and more — to powerful AI models like Claude, GPT-4, and Gemini. This Railway template deploys OpenClaw with a browser-based setup wizard, web terminal, and device management — no CLI, no SSH, no config files required.

**One gateway. Every chat app. Any AI model. Your infrastructure.**

## About Hosting OpenClaw

This template wraps OpenClaw in a production-ready container with a browser-based setup wizard at `/setup`, a web terminal at `/tui`, and a full admin dashboard — all protected by a password you set at deploy time. Your config, credentials, conversation history, and workspace files persist on a Railway Volume so nothing is lost on redeploys.

After deployment, open your Railway URL, complete the 3-step wizard, connect your messaging channels, and start chatting with your AI agent from any device, anywhere.

![OpenClaw Setup Wizard](https://github.com/user-attachments/assets/28640eec-fa35-42f2-ba56-cb1fbb9525de)

## Common Use Cases

- **Personal AI Assistant** — Chat with Claude or GPT via Telegram, Discord, or the web interface for research, writing, coding help, and daily task management
- **Multi-Channel Unified Inbox** — Connect WhatsApp, Telegram, Discord, and Slack to a single AI agent — one brain across all your messaging apps
- **Automated Workflows** — Schedule recurring tasks, monitor websites, send notifications, and run cron jobs via your AI agent
- **Browser Automation** — Let your agent browse the web, extract data, fill forms, and take screenshots autonomously
- **Voice-Enabled Workflows** — Use wake words and voice commands to control your AI agent via macOS, iOS, or Android
- **Multi-Agent Routing** — Route different channels to isolated agents with separate workspaces, sessions, and personas

![OpenClaw Setup Completed](https://github.com/user-attachments/assets/2605d44c-4319-4e92-838c-3caa726b9595)

## OpenClaw vs. Other Self-Hosted AI Agents

### OpenClaw vs. Hermes Agent

Hermes Agent by Nous Research builds a skill library from experience using a learning loop — it gets more capable over time. OpenClaw prioritises breadth: 20+ messaging channel integrations, voice wake words, browser automation, a Live Canvas workspace, and companion apps for macOS, iOS, and Android. If you want deep multi-platform messaging coverage and browser control from day one, OpenClaw is the stronger choice. If you want a self-improving agent that accumulates domain knowledge, Hermes Agent is worth evaluating.

### OpenClaw vs. Auto-GPT

Auto-GPT runs one-shot autonomous tasks and stops. OpenClaw runs as a persistent, always-on gateway — it stays connected to your messaging channels 24/7, maintains session memory per sender, and handles new messages as they arrive. Auto-GPT has no messaging integrations. OpenClaw is your always-available assistant, not a one-time task runner.

### OpenClaw vs. Open WebUI

Open WebUI is a self-hosted chat interface — a browser-based front end for talking to local LLMs. It has no messaging integrations, no cron jobs, no browser automation, and no multi-channel routing. OpenClaw routes messages from Telegram, WhatsApp, Discord, and 17+ other platforms to your AI agent and executes tool calls autonomously. They solve different problems.

## What You Get With This Template

- **OpenClaw Gateway + Control UI** served at `/` and `/openclaw`
- **Browser-based Setup Wizard** at `/setup` — protected by `SETUP_PASSWORD`
- **Web Terminal (TUI)** at `/tui` — run `openclaw` CLI commands from your browser
- **Device Management** — approve and revoke paired devices from the dashboard
- **Persistent Railway Volume** — config, credentials, and memory survive every redeploy

![OpenClaw Web Terminal](https://github.com/user-attachments/assets/61147ec2-ddd5-4b5b-b9ac-0dd81a1ae4c7)

## Dependencies for OpenClaw Hosting

- **AI Provider API Key** — Anthropic Claude, OpenAI GPT, Google Gemini, Groq, or any OpenRouter-supported model
- **Messaging Channel Token** — Telegram bot token (via @BotFather) and/or Discord bot token (via Discord Developer Portal)
- **Railway Volume** — pre-configured in this template. Mounts at `/data` for persistent state

### Deployment Dependencies

- [OpenClaw Official Website](https://openclaw.ai)
- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw)
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [OpenClaw Integrations — 50+ supported platforms](https://openclaw.ai/#integrations)

### Implementation Details

Once deployed, visit `/setup` to complete onboarding. The wizard runs `openclaw onboard --non-interactive` inside the container, writes state to the Railway Volume, and starts the gateway. After setup, `/` is OpenClaw — the wrapper reverse-proxies all traffic including WebSockets to the local gateway process.

```
# Connect Telegram
1. Message @BotFather → /newbot → copy token → paste into /setup

# Connect Discord
1. Discord Developer Portal → New Application → Bot → Copy Token → paste into /setup
2. OAuth2 URL Generator → scopes: bot, applications.commands → invite to server

# Switch AI model after setup (via web terminal at /tui)
openclaw models set anthropic/claude-sonnet-4-20250514
openclaw models list --all
```

The web terminal (`/tui`) requires `ENABLE_WEB_TUI=true` in your Railway Variables. It is disabled by default. Sessions are limited to 1 concurrent user, auto-close after 5 minutes of inactivity, and hard-cap at 30 minutes.

![OpenClaw Device Approval](https://github.com/user-attachments/assets/f30ab683-dbc2-4980-ace7-152265e00c79)

**Environment Variables:**

| Variable | Required | Description |
|---|---|---|
| `SETUP_PASSWORD` | ✅ | Password for `/setup` wizard and `/tui` terminal |
| `ENABLE_WEB_TUI` | Optional | Set `true` to enable web terminal at `/tui`. Default: `false` |
| `OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS` | Optional | Comma-separated list of allowed origins for custom domains |
| `TUI_IDLE_TIMEOUT_MS` | Optional | Idle timeout for web terminal. Default: `300000` (5 min) |
| `TUI_MAX_SESSION_MS` | Optional | Max session duration for web terminal. Default: `1800000` (30 min) |

## Why Deploy OpenClaw on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying OpenClaw on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.