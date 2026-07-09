# Agent install instructions

Use this file to install `linear-pi-agent` for a user. Be proactive: do every step you can do yourself. Only stop to ask the user for information, credentials, browser actions, or infrastructure changes you cannot perform.

## Goal

Set up a service that connects the user's own `pi` agent to Linear Agent Sessions.

## Install flow

### 1. Get the code

If the repository is not already present, clone it and enter the repo directory:

```bash
git clone https://github.com/hiasinho/linear-pi-agent.git
cd linear-pi-agent
```

If the repository is already present, enter it.

Then inspect the project:

```bash
pwd
ls
npm install
npm run typecheck
npm run build
```

If a command fails, fix what you can. Only ask the user when the failure requires their environment, credentials, or a decision.

### 2. Collect required user inputs

Ask the user for only the values you cannot discover:

- public HTTPS base URL for this service, for example `https://agent.example.com`
- target repository path for `PI_WORKDIR`
- Linear client ID
- Linear client secret
- Linear webhook secret
- install secret for `/linear/install`, or generate a random one yourself

Generate `INSTALL_SECRET` yourself if the user does not provide one:

```bash
openssl rand -base64 32
```

Tell the user to create the Linear app manually:

```text
Linear Settings -> API -> New OAuth app
```

Use these Linear settings:

```text
OAuth callback URL: https://YOUR_DOMAIN/linear/oauth/callback
Webhook URL:        https://YOUR_DOMAIN/linear/webhook
Scopes:             read, write, app:assignable, app:mentionable
Webhook events:     Agent Session events
```

Do not repeat Linear's full docs. Link them if needed:

- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/developers/webhooks
- https://linear.app/developers/agent-best-practices

### 3. Check local prerequisites

Run these yourself:

```bash
node --version
npm --version
which pi
```

If `pi` is not installed or not authenticated for the service user, stop and ask the user to install/authenticate pi.

Verify the target repo exists:

```bash
test -d "$PI_WORKDIR"
```

### 4. Write `.env`

Create `.env` from the user's values. Prefer absolute paths.

```dotenv
LINEAR_CLIENT_ID=...
LINEAR_CLIENT_SECRET=...
LINEAR_WEBHOOK_SECRET=...
INSTALL_SECRET=...
LINEAR_REDIRECT_URI=https://YOUR_DOMAIN/linear/oauth/callback
BASE_URL=https://YOUR_DOMAIN
PI_WORKDIR=/absolute/path/to/target/repo
PI_COMMAND=pi
PI_MODE=json
PI_RUNNER=sdk
PI_SESSION_DIR=/absolute/path/to/linear-pi-agent/data/pi-sessions
PI_PROGRESS_DEBOUNCE_MS=3000
PI_PROGRESS_HEARTBEAT_MS=300000
PI_TIMEOUT_MS=1800000
HOST=127.0.0.1
PORT=8787
TOKEN_STORE_PATH=/absolute/path/to/linear-pi-agent/data/linear-tokens.json
STATE_STORE_PATH=/absolute/path/to/linear-pi-agent/data/oauth-states.json
```

Never commit `.env` or print secrets back to the user.

### 5. Build and start

Run:

```bash
npm install
npm run typecheck
npm run build
```

Install/restart the user systemd service:

```bash
install -Dm644 systemd/linear-pi-agent.service.template \
  ~/.config/systemd/user/linear-pi-agent.service
systemctl --user daemon-reload
systemctl --user restart linear-pi-agent
systemctl --user status linear-pi-agent --no-pager
```

If systemd is unavailable, run the service another way and keep it supervised.

### 6. Verify local service

Run:

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

If this fails, inspect logs and fix the service:

```bash
journalctl --user -u linear-pi-agent -n 100 --no-pager
```

### 7. Public HTTPS routing

The user must provide public HTTPS routing to this service. If you can configure the proxy/tunnel in the current environment, do it. Otherwise ask the user to point:

```text
https://YOUR_DOMAIN/* -> http://127.0.0.1:8787/*
```

Then verify it yourself:

```bash
curl -fsS https://YOUR_DOMAIN/healthz
```

Do not continue until the public health check works.

### 8. Install into Linear

Open or give the user this URL:

```text
https://YOUR_DOMAIN/linear/install?install_secret=INSTALL_SECRET
```

The user must complete the browser OAuth flow. After they do, verify token storage exists and inspect logs if needed.

### 9. Run smoke checks

Run the smoke checks yourself:

```bash
npm run smoke:webhook
npm run smoke:linear
```

If they fail, inspect logs and fix what you can.

### 10. Final verification

Ask the user to start a Linear Agent Session. Then watch logs:

```bash
journalctl --user -u linear-pi-agent -f
```

Confirm:

- an `AgentSessionEvent` arrives
- pi starts in `PI_WORKDIR`
- progress is posted back to Linear

## Rules

- Do not offer to do automatable steps; just do them.
- Ask only for secrets, browser actions, infrastructure access, or decisions you cannot make.
- Never commit `.env`, token files, session files, or secrets.
- Keep user prompts short and specific.
- If blocked, say exactly what is needed from the user and why.
