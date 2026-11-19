# paperclip-railway

> A Railway-ready wrapper for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) with a web-based `/setup` page — no CLI access required.

Railway doesn't provide shell access during deployment, so the normal `pnpm paperclipai onboard` flow can't run. This repo solves that by:

1. On first boot, serving a **web-based setup page** at your Railway URL (`/setup`) that checks all required env vars and walks you through configuration.
2. Once you click **Go to Manage**, the setup page starts Paperclip — which automatically runs DB migrations and starts up.
3. You then use the generated invite link or the dashboard button to **register the first admin** — no CLI needed.

---

## OpenRouter adapter

This wrapper bundles an external **OpenRouter** adapter (`openrouter`). It is
registered automatically under **Settings > Adapters** and is selectable when
creating or configuring an agent. Other adapter types are unchanged.

1. Select **OpenRouter** as the adapter.
2. The model is always **openrouter/free**, enforced server-side for existing and
   future agents, even if an old configuration names a paid model or fallback.
3. Store your key in **Settings > Secrets**. In the agent environment editor,
   add `OPENROUTER_API_KEY` as a reference to that secret. A server-level
   `OPENROUTER_API_KEY` also works, but is shared by agents on the instance.
4. Run the environment test, then a small task. Both use the free router.
   Paid fallback and escalation are disabled; every request also has a zero
   prompt/completion price ceiling. Thinking is off for router compatibility.

Do not paste a key into the model, prompt, or an ordinary configuration text field.
Managed AI-account bindings are not supported by this external adapter; use the
secret-backed environment entry instead. Keys are not included in the repository.

OpenRouter handles inference directly. Pi's pinned coding-agent runtime supplies
the tool loop, workspace tools, instructions, skills, streaming, session resume,
and usage accounting. This does **not** invoke OpenCode, Codex, or Claude Code.
The wrapper forwards authenticated WebSocket upgrades for live run updates.
Catalog metadata supplies context/output limits. Nonzero free-router pricing
fails closed rather than allowing paid inference.
For `openrouter/free`, OpenRouter picks a free model per request and does not
publish a fixed completion limit. The adapter caps requests at 4,096 output
tokens (or the lower agent setting); rate limits and routed model limits still apply.

### Free provider pool (Gemini free tier + OpenRouter free)

OpenRouter's free router allows only 50 requests/day on accounts without credits.
When the server has `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) set, every OpenRouter
run is sent through an in-process gateway on `127.0.0.1`. It spreads requests
across Google's free-tier Gemini Flash models (each model has its own quota) and
then `openrouter/free`. On a 429/503 it fails over to the next lane, and it parks
each exhausted lane until its quota window or for at most one hour.

- **Billing guard:** Gemini lanes only run while the key is proven to be free
  tier. The gateway probes a paid-only model and expects a `FreeTier` 429. If the
  Google project ever gets billing, Gemini lanes switch off automatically.
- **Global gate:** when every lane is cooling down, queued runs stay queued
  instead of burning retries. Dispatch resumes automatically once a lane recovers.
- **Secrets:** Pi receives only a per-run gateway token. The real OpenRouter and
  Gemini keys are not passed to Pi or its tool subprocesses.
- **Privacy:** Google may use free-tier Gemini prompts to improve its products.
  Set `PAPERCLIP_FREE_POOL=0` to disable the gateway, or `FREE_POOL_GEMINI=0` to
  keep OpenRouter only. `FREE_POOL_GEMINI_MODELS` overrides the Gemini lane list
  (comma-separated). Gateway telemetry is logged as JSON with `"tag":"freepool"`.

### Permanent hourly recovery

Every failed, timed-out or interrupted OpenRouter run gets a database-backed
`scheduled_retry`, due one hour after its persisted failure timestamp. There is
no finite attempt budget or exponential backoff. Free quota exhaustion, router
unavailability, configuration errors and compact guard stops all wait for the next
hour; no paid model is substituted. Pi's immediate provider/agent retries are
disabled for this adapter.
New-agent verification failures follow the same hourly interval without dropping
accepted work; readiness is never fabricated while the provider is unavailable.

The normal scheduler promotes due retries automatically, so execution resumes on
the next scheduler tick after the hour, not at an exact wall-clock second.
Successor runs retain the task, authorization scope and resumable session.
Database transactions deduplicate simultaneous schedulers, and waiting work
survives restarts/deployments. A recurring sweep also recovers the latest
unsuperseded failure of existing tasks and agent-only runs, including tasks
automatically blocked by the system. Previously scheduled retries are normalized
to the same one-hour rule.

Completed/cancelled tasks, superseded runs, human-blocked tasks, deliberately
stopped runs, manually paused agents/session goals, approvals, dependencies and
budget/authorization gates are not overridden. Repair permanent configuration
errors when reported; hourly attempts continue while work remains eligible.
An upstream change that no longer matches the boot-time compatibility patch
stops startup explicitly rather than silently reverting to short/bounded retries.

### Compact mode for low-cost models

Select **Compact (issue runs)** on one agent first; Standard remains the default.
Compact gives the model three tools to read the current issue, post an update,
and set `done` or `blocked`. Configure a **Compact verification command** that
actually checks the expected outcome (for example `npm test` for a test-backed
code task). The status tool refuses `done` unless that exact command succeeded
after the last write, edit, or shell action. Without a verifier it can report
`blocked`, but cannot close the issue. This is a workflow guard for trusted
agents, not a sandbox or proof that an inadequate verifier checked the task.

Compact stops the third identical tool call and defaults to 30 calls,
80,000 reported input tokens per attempt, and 600 seconds. The input budget is
checked after each response, so a request already sent can overshoot. Guard
stops retain their per-attempt bounds and resume in the hourly recovery lane.
Paperclip's `timeoutSec: 0` sentinel uses the bounded profile default (Standard:
300 seconds, Compact: 600 seconds), rather than disabling the adapter timeout.

Saved fallback/escalation fields are ignored. Caching depends on the free model
chosen by OpenRouter; cache hits are not guaranteed.

Sessions persist under `/paperclip/openrouter/sessions`. On first boot, the wrapper
links Pi's session directory there. It refuses to overwrite an existing Pi session
directory or a different installed adapter named `openrouter`.

For local development, run `npm install`, `npm run build`, then `npm test`.
In a disposable Linux environment with `node_modules/.bin` on `PATH`, run
`OPENROUTER_PI_INTEGRATION=1 node --test adapters/openrouter/pi-integration.test.mjs`
to exercise actual Pi against local fake OpenRouter and Paperclip endpoints.
For durable queue tests, point `OPENROUTER_TEST_DATABASE_URL` at a disposable
local PostgreSQL database named `openrouter_retry_test`, then run
`node --test scripts/openrouter-recovery.integration.test.mjs`. It applies
Paperclip migrations and creates synthetic fixtures; never use production data.
The generated browser transcript parser is bundled from Paperclip's Pi adapter.
The CLI is pinned to patched Pi `0.78.1`; runtime upgrades must preserve tool
execution and session resume.

### Upstream channels

Production follows the public `paperclipai@latest` stable channel, not the age of
the Railway template. The Pi integration is refreshed alongside Paperclip on boot.
As checked on 2026-11-18, stable is `2026.1106.0`; newer public builds exist on
`beta`, `nightly`, and `canary`, but are prereleases. Neither the stable source nor
public development head has a standalone OpenRouter adapter. Upgrading to a
prerelease is a separate migration and should be tested before using production
data. The bundled adapter uses the supported external-adapter API instead of
patching Paperclip's built-in adapter list.

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
        │     proxy :3100 → internal Paperclip on :3099 after /api/health responds
        └── env var readiness is derived from reality (config.json + required env vars);
            there is no SETUP_COMPLETE env var or .setup_complete flag file
```

The setup page auto-polls env vars by hitting `/setup/status` — each var shows as ✓ Set or ✗ Missing in real time.

---

## Files

```
paperclip-railway/
├── Dockerfile            # Node 24 image with gosu, ca-certificates, and agent CLIs
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

**OpenCode/Gemini reports `Requests ending with a model turn are not supported`**
→ This is an OpenCode regression affecting Gemini BYOK requests in OpenCode 1.18.21 and newer. This template uses OpenCode 1.18.20 until the upstream fix is released; redeploy so Railway installs that version.

**An agent run fails**
→ OpenRouter uses persistent unlimited hourly retries (see above). The existing 60-second recovery policy for other adapters is unchanged. A retry creates a new run using the same agent and task; correct permanent configuration problems when reported.

**Gemini adapter fails with `Command not found in PATH: "gemini"`**
→ Ensure the service is running the latest image so `@google/gemini-cli` is installed, then redeploy/restart.

**Gemini adapter fails with `Gemini API key is missing or not configured` (ACP engine)**
→ Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in Railway variables and redeploy/restart. On boot this wrapper mirrors the two variable names onto each other and writes `~/.gemini/settings.json` pinning `security.auth.selectedType` to `gemini-api-key`. Both steps are required: Gemini's ACP mode resolves the key from `GEMINI_API_KEY` only — `GOOGLE_API_KEY` is read exclusively on the Vertex AI auth path — and a previously persisted `oauth-personal` auth type would otherwise shadow the key permanently. Paperclip itself only seeds this file for *remote* agent homes, so on Railway (a local execution target) nothing wrote it before.

**Gemini adapter fails with `Method not found: session/set_config_option` (ACP -32601)**
→ Redeploy with the latest template. Gemini CLI's ACP server does not implement that configuration method, but Paperclip currently uses it when an adapter model is selected. On boot this wrapper applies the pending [upstream fix](https://github.com/paperclipai/paperclip/pull/11231): it passes the model through Gemini's startup `--model` option and skips unsupported dynamic ACP configuration calls.

**Gemini logs show `Skipping project agents due to untrusted folder` / `Project hooks disabled because the folder is not trusted`**
→ Fixed by the same `~/.gemini/settings.json` seeding, which disables Gemini's folder-trust gate (`security.folderTrust.enabled: false`). Left at its default, that gate also silently downgrades the agent's approval mode away from yolo. The `GEMINI_CLI_TRUST_WORKSPACE` environment variable does *not* help here — Paperclip spawns the ACP agent with an env allowlist that drops it.

**Gemini adapter fails with `Error: spawn E2BIG` (Gemini CLI engine)**
→ Switch the agent's `gemini_local` adapter back to the **ACP engine** (`engine: "acp"`, the default). This is an upstream Paperclip limitation rather than a Railway one: the CLI engine passes the whole composed prompt as a single `--prompt <...>` command-line argument, and Linux rejects any single argument larger than 128 KiB with `E2BIG`. Long instructions plus a session handoff cross that limit. The ACP engine sends the prompt over the ACP JSON-RPC stdio channel instead, so it has no such ceiling. If you must stay on the CLI engine, shrink the agent's `instructionsFilePath` / `promptTemplate`.

**Dashboard reports Minified React error #185**
→ Restart or redeploy the service, then reload after it is healthy. The wrapper checks for and installs the newest Paperclip release on every startup, so it automatically receives upstream UI fixes.

## Paperclip updates

Paperclip is intentionally declared as `latest` in `package.json` and refreshed on every container start by `scripts/start.mjs`. Do not pin its version: new upstream releases are applied automatically on Railway restarts and redeploys.

Security overrides update Svix and Zod. Paperclip's published server also bundles an older Zod copy, which is replaced with the patched version during image builds and after startup updates. npm audit may still report that bundled copy from upstream package metadata.

This repo requires **Node.js 24.15.0 or higher** (see `package.json` and `Dockerfile`). If upstream Paperclip bumps its Node requirement, update both files accordingly.

## Keeping this fork up to date

While the `paperclipai` package itself auto-updates on every restart (see above), breaking changes upstream — a new required config key, a bumped Node.js requirement, a changed CLI flag — can still break the Railway deployment until this wrapper (`Dockerfile`, `entrypoint.sh`, `scripts/start.mjs`) is adjusted for it. The same applies to fixes landing in the template this repo was forked from, [praveen-ks-2001/paperclip-railway-template](https://github.com/praveen-ks-2001/paperclip-railway-template).

The [`.github/workflows/upstream-watch.yml`](.github/workflows/upstream-watch.yml) workflow automates catching and fixing these:

1. It runs daily (and on manual `workflow_dispatch`), checking for a new `paperclipai` npm release and new commits on the upstream template's `main` branch, against the last-seen values recorded in `.github/upstream-state.json`.
2. If either changed, it opens a GitHub issue summarizing what's new and asking for the necessary Railway-compatibility fixes.
3. It assigns that issue to the **Copilot coding agent**, which investigates and opens a pull request with the fixes.
4. It records the new versions in `.github/upstream-state.json` so the next run only reports genuinely new changes.

**Setup**: assigning issues to Copilot via the API requires a user token from a Copilot-licensed account (the workflow's default `GITHUB_TOKEN` can't hold a Copilot seat). Create a personal access token with `repo` scope from such an account and add it as the `COPILOT_PAT` repository secret. Without it, the workflow still opens the issue — just without the automatic assignment — so it can be assigned to Copilot manually.
