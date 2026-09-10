# paperclip-railway

> A Railway-ready wrapper for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) with a web-based `/setup` page — no CLI access required.

Railway doesn't provide shell access during deployment, so the normal `pnpm paperclipai onboard` flow can't run. This repo solves that by:

1. On first boot, serving a **web-based setup page** at your Railway URL (`/setup`) that checks all required env vars and walks you through configuration.
2. Once you click **Go to Manage**, the setup page starts Paperclip — which automatically runs DB migrations and starts up.
3. You then use the generated invite link or the dashboard button to **register the first admin** — no CLI needed.

---

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-ai-company?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Manual steps

1. **Fork or clone this repo** into your own GitHub account.

2. **Create a new Railway project** and add:
   - A **PostgreSQL** database service (Railway managed)
   - A **new service** pointing at your fork of this repo

3. **Add a volume** to the Paperclip service, mounted at `/paperclip`.

4. **Set these environment variables** on the Paperclip service:

```env
# Required
DATABASE_URL="${{Postgres.DATABASE_URL}}"
BETTER_AUTH_SECRET="${{secret(32)}}"
PAPERCLIP_PUBLIC_URL="https://your-app.up.railway.app"
PAPERCLIP_ALLOWED_HOSTNAMES="your-app.up.railway.app"

# Optional but recommended
PAPERCLIP_DEPLOYMENT_MODE="authenticated"
PAPERCLIP_DEPLOYMENT_EXPOSURE="public"
PAPERCLIP_HOME="/paperclip"
HOST="0.0.0.0"
PORT="3100"
NODE_ENV="production"

# At least one agent API key is required for agent runs
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="AIza..."
# GOOGLE_API_KEY is also accepted for Gemini
```

5. **Deploy** — Railway will run `npm start` which serves the setup page.

6. **Open your Railway URL** — you'll see the setup page. Verify all required vars are green, then click **Go to Manage**.

7. **Register the first admin** using the bootstrap invite link shown on the Manage tab. If an admin already exists, log in via the dashboard link instead.

8. **Lock sign-ups**: go back to Railway Variables, add `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, and redeploy.

---

## How it works

```
npm start
  └── scripts/start.mjs
        ├── always serve setup UI on PORT (3100) at /setup
        ├── when "Go to Manage" is clicked and env vars are ready:
        │     write minimal config.json to PAPERCLIP_HOME
        │     spawn: paperclipai run
        │     proxy :3100 → internal Paperclip on :3099
        └── env var readiness is derived from reality (config.json + required env vars);
            there is no SETUP_COMPLETE env var or .setup_complete flag file
```

The setup page auto-polls env vars by hitting `/setup/status` — each var shows as ✓ Set or ✗ Missing in real time.

---

## Files

```
paperclip-railway/
├── Dockerfile            # Node 24.11 image with gosu, ca-certificates, and agent CLIs
├── entrypoint.sh         # fixes /paperclip volume ownership, then drops to non-root user
├── package.json          # installs paperclipai + local agent CLIs, defines start script
├── scripts/
│   ├── setup.html        # web-based setup / management UI
│   └── start.mjs         # setup server + config writer + paperclip launcher/proxy
└── README.md
```

---

## After first launch

Once Paperclip is running, this wrapper is transparent — it proxies public traffic on `PORT` to Paperclip's internal port (`3099`) while continuing to serve `/setup/*` for management. On subsequent container restarts, Paperclip starts automatically as soon as `config.json` exists and the required env vars are set.

---

## Troubleshooting

**Setup page keeps reappearing after redeploy**
→ The `/paperclip` volume wasn't attached. Make sure the volume is mounted at `/paperclip` in Railway's service settings.

**Auth errors / blank screen after login**
→ `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` don't match your Railway domain. Update them and redeploy.

**`DATABASE_URL` SSL errors**
→ Add `DATABASE_SSL_REJECT_UNAUTHORIZED=false` to your Railway env vars.

**Paperclip starts but agents can't connect or the dashboard shows a private-deployment error**
→ Make sure `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` is set so the server accepts external connections. This is the default used by `start.mjs`, but set it explicitly in Railway variables to be safe.

**Agent runs fail with `401 Unauthorized: Missing bearer` (Codex / OpenAI)**
→ The Codex CLI (≥ 0.122) ignores the `OPENAI_API_KEY` env var and only reads credentials from `$CODEX_HOME/auth.json`. On boot, this wrapper seeds `~/.codex/auth.json` from `OPENAI_API_KEY` so Paperclip propagates it to each agent's Codex home. If you set the key after the first deploy, redeploy (or restart) so the file is written, then retry the task.

**OpenCode adapter probe fails with `opencode: command not found`**
→ Ensure the service was deployed with the latest dependencies so `opencode-ai` is installed, then redeploy/restart.

**Gemini adapter fails with `Command not found in PATH: "gemini"`**
→ Ensure the service is running the latest image so `@google/gemini-cli` is installed, then redeploy/restart.

**Gemini adapter fails with `Gemini API key is missing or not configured` (ACP engine)**
→ Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in Railway variables and redeploy/restart. On boot this wrapper mirrors the two variable names onto each other and writes `~/.gemini/settings.json` pinning `security.auth.selectedType` to `gemini-api-key`. Both steps are required: Gemini's ACP mode resolves the key from `GEMINI_API_KEY` only — `GOOGLE_API_KEY` is read exclusively on the Vertex AI auth path — and a previously persisted `oauth-personal` auth type would otherwise shadow the key permanently. Paperclip itself only seeds this file for *remote* agent homes, so on Railway (a local execution target) nothing wrote it before.

**Gemini logs show `Skipping project agents due to untrusted folder` / `Project hooks disabled because the folder is not trusted`**
→ Fixed by the same `~/.gemini/settings.json` seeding, which disables Gemini's folder-trust gate (`security.folderTrust.enabled: false`). Left at its default, that gate also silently downgrades the agent's approval mode away from yolo. The `GEMINI_CLI_TRUST_WORKSPACE` environment variable does *not* help here — Paperclip spawns the ACP agent with an env allowlist that drops it.

**Gemini adapter fails with `Error: spawn E2BIG` (Gemini CLI engine)**
→ Switch the agent's `gemini_local` adapter back to the **ACP engine** (`engine: "acp"`, the default). This is an upstream Paperclip limitation rather than a Railway one: the CLI engine passes the whole composed prompt as a single `--prompt <...>` command-line argument, and Linux rejects any single argument larger than 128 KiB with `E2BIG`. Long instructions plus a session handoff cross that limit. The ACP engine sends the prompt over the ACP JSON-RPC stdio channel instead, so it has no such ceiling. If you must stay on the CLI engine, shrink the agent's `instructionsFilePath` / `promptTemplate`.

**Dashboard reports Minified React error #185**
→ Restart or redeploy the service, then reload after it is healthy. The wrapper checks for and installs the newest Paperclip release on every startup, so it automatically receives upstream UI fixes.

## Paperclip updates

Paperclip is intentionally declared as `latest` in `package.json` and refreshed on every container start by `scripts/start.mjs`. Do not pin its version: new upstream releases are applied automatically on Railway restarts and redeploys.

This repo requires **Node.js >=24.11.0** (see `package.json` and `Dockerfile`). If upstream Paperclip bumps its Node requirement, update both files accordingly.

## Keeping this fork up to date

While the `paperclipai` package itself auto-updates on every restart (see above), breaking changes upstream — a new required config key, a bumped Node.js requirement, a changed CLI flag — can still break the Railway deployment until this wrapper (`Dockerfile`, `entrypoint.sh`, `scripts/start.mjs`) is adjusted for it. The same applies to fixes landing in the template this repo was forked from, [praveen-ks-2001/paperclip-railway-template](https://github.com/praveen-ks-2001/paperclip-railway-template).

The [`.github/workflows/upstream-watch.yml`](.github/workflows/upstream-watch.yml) workflow automates catching and fixing these:

1. It runs daily (and on manual `workflow_dispatch`), checking for a new `paperclipai` npm release and new commits on the upstream template's `main` branch, against the last-seen values recorded in `.github/upstream-state.json`.
2. If either changed, it opens a GitHub issue summarizing what's new and asking for the necessary Railway-compatibility fixes.
3. It assigns that issue to the **Copilot coding agent**, which investigates and opens a pull request with the fixes.
4. It records the new versions in `.github/upstream-state.json` so the next run only reports genuinely new changes.

**Setup**: assigning issues to Copilot via the API requires a user token from a Copilot-licensed account (the workflow's default `GITHUB_TOKEN` can't hold a Copilot seat). Create a personal access token with `repo` scope from such an account and add it as the `COPILOT_PAT` repository secret. Without it, the workflow still opens the issue — just without the automatic assignment — so it can be assigned to Copilot manually.
