# Contributing to Moltbot Railway Template

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/moltbot-railway-template.git`
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Test thoroughly (see Testing section below)
6. Commit with clear messages
7. Push and create a Pull Request

## Development Setup

### Local Development

```bash
# Clone the repo
git clone https://github.com/codetitlan/moltbot-railway-template.git
cd moltbot-railway-template

# Install dependencies (none! Node.js only)
# This project has zero npm dependencies for the wrapper itself

# Set environment variables
export SETUP_PASSWORD=test
export OPENCLAW_STATE_DIR=/tmp/openclaw-test/.openclaw
export OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-test/workspace
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Run the wrapper
npm run dev
# or
node src/server.js

# Visit http://localhost:8080/setup (password: test)
```

### Docker Testing

```bash
# Build the image
docker build -t moltbot-test .

# Run with volume
docker run --rm -p 8080:8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  moltbot-test

# Visit http://localhost:8080/setup
```

## Code Style

- Use clear, descriptive variable names
- Add comments for complex logic
- Keep functions focused and small
- Use async/await over callbacks
- Handle errors gracefully
- Log important events to console
- Use `debug()` helper for verbose logging (only logs when `OPENCLAW_TEMPLATE_DEBUG=true`)
- Never log sensitive tokens/keys unless behind DEBUG flag

## Testing Requirements

Before submitting a PR, test:

1. **Syntax validation**
   ```bash
   node -c src/server.js
   ```

2. **Fresh setup flow**
   - Delete config and workspace
   - Run through `/setup` wizard
   - Verify all channels work

3. **Debug Console**
   - Test each command in debug console
   - Verify error handling
   - Test with invalid arguments

4. **Config Editor**
   - Load, modify, save config
   - Verify backup creation
   - Verify gateway restart
   - Test with invalid JSON

5. **Import/Export**
   - Export backup
   - Reset setup
   - Import backup
   - Verify full restoration

6. **Health endpoints**
   - `/healthz` returns correct status
   - `/setup/api/debug` shows diagnostics

7. **Docker build**
   ```bash
   docker build -t moltbot-test .
   # Should complete without errors
   ```

## Adding New Debug Console Commands

1. Add command to the `allowedCommands` Set in `src/server.js`:
   ```javascript
   const allowedCommands = new Set([
     "gateway.restart",
     // ... existing commands ...
     "openclaw.your.command",  // Add your command
   ]);
   ```

2. Add command handling logic in the switch statement:
   ```javascript
   case "openclaw.your.command": {
     // Validate args if needed
     if (!args?.trim()) {
       return res.status(400).json({ ok: false, error: "Argument required" });
     }
     
     // Execute command
     const result = await runCmd(
       OPENCLAW_NODE,
       clawArgs(["your", "command", args.trim()])
     );
     
     // Return redacted output
     return res.json({
       ok: true,
       output: redactSecrets(result.output),
       exitCode: result.code,
     });
   }
   ```

3. Add UI option in `src/public/setup.html`:
   ```html
   <optgroup label="Your Category">
     <option value="openclaw.your.command">openclaw your command &lt;arg&gt;</option>
   </optgroup>
   ```

4. Test thoroughly with various inputs

## Areas for Contribution

### High Priority
- [ ] Add automated tests (currently manual testing only)
- [ ] Improve error messages and diagnostics
- [ ] Better logging/debugging capabilities
- [ ] Performance optimization
- [ ] Add rate limiting to prevent abuse

### Medium Priority
- [ ] More custom provider examples and validation
- [ ] Better UI/UX in setup wizard
- [ ] More debug console commands
- [ ] Internationalization (i18n)
- [ ] Add health check retries and backoff

### Low Priority
- [ ] Theme customization
- [ ] Advanced config validation
- [ ] Backup scheduling
- [ ] Metrics and monitoring

## Pull Request Process

1. **Update documentation** if adding features:
   - README.md for user-facing features
   - CLAUDE.md for technical implementation details
   - CONTRIBUTING.md for new development workflows

2. **Test on Railway** (not just locally):
   - Deploy to Railway test environment
   - Verify all features work end-to-end
   - Check logs for errors

3. **Include screenshots** if UI changes:
   - Before/after comparisons
   - Show new features in action

4. **Reference related issues**:
   - Use "Fixes #123" or "Closes #123" in PR description
   - Explain why the change is needed

5. **Keep PRs focused**:
   - One feature/fix per PR
   - Avoid mixing refactoring with new features

## Reporting Issues

When filing an issue, include:

### 1. Environment
- Railway or local Docker?
- OpenClaw version (`openclaw --version` via Debug Console)
- Node.js version
- Browser (if UI issue)

### 2. Steps to Reproduce
- Exact steps to trigger the issue
- Expected vs actual behavior
- Any error messages

### 3. Diagnostics (if applicable)
- Output from `/healthz`
- Output from `/setup/api/debug`
- Relevant logs from Railway

### 4. Config (redact secrets!)
- Relevant parts of `openclaw.json`
- Environment variables (without values)
- Any custom configuration

## Security

### Reporting Security Issues

**DO NOT** open a public issue for security vulnerabilities.

Instead, email: [security contact TBD]

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Security Best Practices

When contributing code:
- Never log sensitive data (tokens, passwords, keys) unless behind DEBUG flag
- Validate all user input
- Use parameterized commands (avoid shell injection)
- Set restrictive file permissions (700 for credentials)
- Use path traversal prevention for file operations
- Implement rate limiting on sensitive endpoints
- Use HTTPS for all external requests

## Code Review Process

All contributions go through code review:

1. **Automated checks**:
   - Syntax validation
   - Integration tests (if available)
   - Docker build test

2. **Manual review**:
   - Code quality and style
   - Security considerations
   - Performance impact
   - Documentation completeness

3. **Testing**:
   - Reviewer tests on Railway
   - Verifies no regressions
   - Checks edge cases

4. **Approval**:
   - At least 1 approval required
   - All comments addressed
   - Tests passing

## Questions?

- Open a GitHub Issue for general questions
- Ask in Discord: https://discord.com/invite/clawd
- Check existing docs: README.md, CLAUDE.md, MIGRATION.md

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

## Thank You!

Your contributions help make this project better for everyone. We appreciate your time and effort!
