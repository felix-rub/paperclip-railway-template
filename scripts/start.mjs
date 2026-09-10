#!/usr/bin/env node
/**
 * paperclip-railway/scripts/start.mjs
 *
 * Startup wrapper for paperclipai on Railway.
 *
 * Port layout:
 *   PUBLIC_PORT (3100) — owned by this wrapper, always
 *   PAPERCLIP_PORT (3099) — internal, Paperclip only
 *
 * Routing:
 *   /setup/*  → always handled here (env check, launch, invite, reset)
 *   /         → proxy if ready, else redirect to /setup
 *   everything else → proxy if ready, else redirect to /setup
 *
 * "Ready" is derived — no flag files, no SETUP_COMPLETE env var.
 *   isReady() = config.json exists AND all 4 required env vars are set
 */

import { createServer, request as httpRequest } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = parseInt(process.env.PORT || "3100", 10);
const PAPERCLIP_PORT = 3099;
const HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const CONFIG_PATH = join(HOME, "config.json");
const INVITE_FILE = join(HOME, "bootstrap-invite.txt");
const SKIP_REASON_FILE = join(HOME, "bootstrap-skip-reason.txt");
const APP_ROOT = join(__dirname, "..");

// Shared Codex home — Paperclip's codex adapter seeds each company's managed
// Codex home from here (it mirrors @paperclipai's resolveSharedCodexHomeDir).
const SHARED_CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const CODEX_AUTH_PATH = join(SHARED_CODEX_HOME, "auth.json");

// Gemini CLI reads its user settings from $HOME/.gemini/settings.json. Both the
// ACP engine (`gemini --acp`) and the CLI engine run as this same user locally.
const GEMINI_HOME = join(homedir(), ".gemini");
const GEMINI_SETTINGS_PATH = join(GEMINI_HOME, "settings.json");

// Strip ANSI escape sequences (colors, cursor, etc.) from strings
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Global state ─────────────────────────────────────────────────────────────

let paperclipProc = null;
let paperclipReady = false;
let inviteUrl = null;
let bootstrapSkippedReason = null;
let bootstrapAttempted = false; // guards the one-shot auto-generate after Paperclip is ready

// ── Ready check (derived from reality, no flags) ─────────────────────────────

const REQUIRED_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
];

function isReady() {
  return REQUIRED_VARS.every(k => !!process.env[k]) && existsSync(CONFIG_PATH);
}

function allEnvVarsSet() {
  return REQUIRED_VARS.every(k => !!process.env[k]);
}

// A Docker dependency layer can be reused after Paperclip releases a new version.
// Refresh on boot so every Railway restart runs the current `latest` release.
function updatePaperclip() {
  console.log("🔄 Checking for the latest Paperclip release...");
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath || "node_modules/npm/bin/npm-cli.js", "install", "--omit=dev", "--no-save", "--package-lock=false", "paperclipai@latest"],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    console.warn(`⚠️ Could not refresh Paperclip; using the installed release.${result.error ? ` ${result.error.message}` : ""}`);
  }
}

// ── Config builder ────────────────────────────────────────────────────────────

function writeConfig() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(HOME, "logs"), { recursive: true });
  mkdirSync(join(HOME, "storage"), { recursive: true });
  mkdirSync(join(HOME, "backups"), { recursive: true });

  const config = {
    $meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      // Paperclip's schema keys this on `mode` ("postgres" | "embedded-postgres"),
      // defaulting to embedded. Use the external Railway Postgres when DATABASE_URL is set.
      mode: process.env.DATABASE_URL ? "postgres" : "embedded-postgres",
      connectionString: process.env.DATABASE_URL || undefined,
      // Keep DB backups on the persistent volume; the schema default points at
      // ~/.paperclip/... which is ephemeral container disk on Railway.
      backup: { dir: join(HOME, "backups") },
    },
    logging: {
      mode: "file",
      logDir: join(HOME, "logs"),
    },
    server: {
      deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
      exposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
      allowedHostnames: (process.env.PAPERCLIP_ALLOWED_HOSTNAMES || "")
        .split(",").map(h => h.trim()).filter(Boolean),
      port: PAPERCLIP_PORT,
      host: "127.0.0.1",
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: process.env.PAPERCLIP_PUBLIC_URL || "",
      disableSignUp: process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: join(HOME, "storage") },
    },
    secrets: {
      provider: "local_encrypted",
      localEncrypted: {
        keyFilePath: join(HOME, "secrets.key"),
      },
    },
  };

  // Always overwrite — keeps config in sync with env vars on every boot
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`   Config written to ${CONFIG_PATH}`);
}

// ── Codex auth seeding ────────────────────────────────────────────────────────
//
// Codex CLI (>= 0.122) ignores the OPENAI_API_KEY environment variable — it only
// reads credentials from $CODEX_HOME/auth.json. Paperclip's codex adapter writes
// that file itself, but ONLY when the key is present in its own adapter config
// (config.env.OPENAI_API_KEY), not from the OS environment. On Railway the key
// only exists as an OS env var, so nothing ever authenticates and every Codex run
// fails with "401 Unauthorized: Missing bearer or basic authentication".
//
// Fix: write the key into the shared Codex home ourselves, matching the exact
// schema Paperclip uses (writeApiKeyAuthJson → { OPENAI_API_KEY }). Paperclip then
// symlinks this shared auth.json into each company's managed Codex home
// (SYMLINKED_SHARED_FILES), so it propagates to every agent automatically.
//
// Note: the Claude adapter needs no equivalent — the Claude Code CLI reads
// ANTHROPIC_API_KEY straight from the environment.
function seedCodexAuth() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) {
    mkdirSync(SHARED_CODEX_HOME, { recursive: true });
    writeFileSync(CODEX_AUTH_PATH, JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
    console.log(`   Seeded Codex auth.json at ${CODEX_AUTH_PATH}`);
  } else if (existsSync(CODEX_AUTH_PATH)) {
    // Key removed from env — drop the stale credential so Codex can fall back to
    // subscription/login auth instead of presenting a now-invalid key.
    unlinkSync(CODEX_AUTH_PATH);
    console.log(`   Removed stale Codex auth.json (OPENAI_API_KEY unset)`);
  }
}

// ── Gemini auth + trust seeding ───────────────────────────────────────────────
//
// Two separate Railway-specific breakages, both fixed here:
//
// 1. Key naming. Gemini's ACP mode (`gemini --acp`, used by Paperclip's default
//    "acp" engine) picks the `gemini-api-key` auth type and then resolves the key
//    from GEMINI_API_KEY only. GOOGLE_API_KEY is read exclusively on the
//    `vertex-ai` path, so a Railway variable named GOOGLE_API_KEY fails
//    `session/new` with "Gemini API key is missing or not configured.". Mirror the
//    two names so either spelling works, before Paperclip is spawned — Paperclip's
//    acpx engine projects both onto the agent child, but Gemini only reads one.
//
// 2. Settings file. Paperclip writes ~/.gemini/settings.json only for *remote*
//    managed agent homes; on Railway the execution target is local, so nothing
//    seeds it (Paperclip's own Docker image bakes the file — this image is built
//    from node:slim and did not). Without it:
//      • the auth type is never pinned, so a stray ACP `authenticate` call can
//        persist `oauth-personal` and permanently shadow the API key;
//      • folder trust stays enabled (its default), leaving every agent workspace
//        untrusted — hence "Skipping project agents due to untrusted folder" and
//        "Project hooks disabled because the folder is not trusted" in the logs,
//        which also silently downgrades the approval mode away from yolo.
//    The GEMINI_CLI_TRUST_WORKSPACE env var cannot fix this on the ACP lane:
//    Paperclip's acpx engine spawns the agent with an env allowlist that drops it.
//    The user-scope settings file is the only lever that reaches both engines.
function seedGeminiConfig() {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const googleKey = process.env.GOOGLE_API_KEY?.trim();
  const key = geminiKey || googleKey;
  if (!key) return;

  if (!geminiKey) {
    process.env.GEMINI_API_KEY = googleKey;
  } else if (!googleKey) {
    process.env.GOOGLE_API_KEY = geminiKey;
  } else if (geminiKey !== googleKey) {
    console.warn(
      "   Warning: GEMINI_API_KEY and GOOGLE_API_KEY are both set with different values; preserving both and using GEMINI_API_KEY for Gemini settings."
    );
  }

  // Merge into any existing file rather than overwriting it — Gemini CLI persists
  // its own keys here and users may have added settings of their own.
  let settings = {};
  if (existsSync(GEMINI_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(GEMINI_SETTINGS_PATH, "utf8"));
      if (parsed && typeof parsed === "object") settings = parsed;
    } catch (_) {
      console.warn(`   Ignoring unparsable ${GEMINI_SETTINGS_PATH}; rewriting it.`);
    }
  }

  settings.security = {
    ...settings.security,
    auth: { ...settings.security?.auth, selectedType: "gemini-api-key" },
    folderTrust: { ...settings.security?.folderTrust, enabled: false },
  };
  // Pre-1.0 Gemini CLI releases read the flat key instead of security.auth.
  settings.selectedAuthType = "gemini-api-key";

  mkdirSync(GEMINI_HOME, { recursive: true });
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`   Seeded Gemini settings at ${GEMINI_SETTINGS_PATH}`);
}

// ── Paperclip process ─────────────────────────────────────────────────────────

function startPaperclip() {
  if (paperclipProc) return; // already running

  console.log(`\n🚀 Starting Paperclip on internal port ${PAPERCLIP_PORT}...\n`);

  writeConfig();
  seedCodexAuth();

  paperclipProc = spawn(
    "node",
    ["node_modules/.bin/paperclipai", "run"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PAPERCLIP_CONFIG: CONFIG_PATH,
        PAPERCLIP_HOME: HOME,
        PORT: String(PAPERCLIP_PORT),
        HOST: "127.0.0.1",
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    }
  );

  paperclipProc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    const clean = stripAnsi(text);

    // Capture bootstrap invite URL
    const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
    if (match) {
      inviteUrl = match[0].trim();
      bootstrapSkippedReason = null;
      writeFileSync(INVITE_FILE, inviteUrl);
      if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
      console.log(`\n✅ Bootstrap invite URL saved to ${INVITE_FILE}\n`);
    }

    // Detect "admin already exists" — Paperclip skips invite generation
    if (clean.includes("Instance already has an admin user")) {
      bootstrapSkippedReason = "An admin account already exists. You can log in directly from the dashboard.";
      writeFileSync(SKIP_REASON_FILE, bootstrapSkippedReason);
      console.log(`\n⚠️ Bootstrap invite skipped: admin already exists.\n`);
    }

    // Detect ready
    if (!paperclipReady && (text.includes("Server listening on") || text.includes("server listening"))) {
      paperclipReady = true;
      console.log(`\n✅ Paperclip ready — proxying :${PUBLIC_PORT} → :${PAPERCLIP_PORT}\n`);

      // Current Paperclip versions no longer print the first-admin bootstrap invite on `run`
      // (they show a "waiting on first admin" page instead). If we didn't capture one from
      // stdout, generate it ourselves so the Manage tab's registration link appears automatically.
      if (!inviteUrl && !bootstrapSkippedReason && !bootstrapAttempted) {
        bootstrapAttempted = true;
        setTimeout(() => {
          if (!inviteUrl && !bootstrapSkippedReason) {
            console.log("\nℹ️ No bootstrap invite seen at startup — generating first-admin invite...\n");
            generateBootstrapInvite(false);
          }
        }, 1500);
      }
    }
  });

  paperclipProc.stderr.on("data", chunk => process.stderr.write(chunk));

  paperclipProc.on("error", err => {
    console.error("Paperclip process error:", err);
    paperclipProc = null;
    paperclipReady = false;
  });

  paperclipProc.on("exit", (code) => {
    console.log(`Paperclip exited with code ${code}`);
    // Railway will restart the whole container on exit — don't try to restart here
    process.exit(code ?? 1);
  });
}

// Generate (or refresh) the first-admin bootstrap invite by running the Paperclip CLI.
// Without --force it no-ops when an admin already exists (we surface that as the skip reason).
// With --force it always mints a fresh invite (used by the "Rotate" button).
function generateBootstrapInvite(force = false) {
  return new Promise((resolve) => {
    const args = ["node_modules/.bin/paperclipai", "auth", "bootstrap-ceo"];
    if (force) args.push("--force");

    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAPERCLIP_CONFIG: CONFIG_PATH, PAPERCLIP_HOME: HOME },
    });

    let out = "";
    const scan = (chunk) => {
      out += chunk.toString();
      const clean = stripAnsi(out);
      const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
      if (match) {
        inviteUrl = match[0].trim();
        bootstrapSkippedReason = null;
        writeFileSync(INVITE_FILE, inviteUrl);
        if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
      }
      if (clean.includes("Instance already has an admin user")) {
        bootstrapSkippedReason = "An admin account already exists. You can log in directly from the dashboard.";
        writeFileSync(SKIP_REASON_FILE, bootstrapSkippedReason);
      }
    };

    // bootstrap-ceo may print to either stream depending on version — scan both.
    proc.stdout.on("data", scan);
    proc.stderr.on("data", (d) => { process.stderr.write(d); scan(d); });
    proc.on("error", (err) => { console.error("bootstrap-ceo error:", err); resolve(); });
    proc.on("exit", () => resolve());
  });
}

function stopPaperclip() {
  if (!paperclipProc) return;
  paperclipReady = false;
  paperclipProc.kill("SIGTERM");
  paperclipProc = null;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetSetup() {
  stopPaperclip();
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(INVITE_FILE)) unlinkSync(INVITE_FILE);
  if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
  inviteUrl = null;
  bootstrapSkippedReason = null;
  console.log("\n🔄 Setup reset. Config and invite file deleted.\n");
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function proxy(req, res) {
  if (!paperclipReady) {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f10;color:#fff">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:16px">⏳</div>
        <h2>Paperclip is starting up...</h2>
        <p style="color:#71717a;margin-top:8px">This page will refresh automatically.</p>
        <script>setTimeout(()=>location.reload(),3000)<\/script>
      </div></body></html>`);
    return;
  }

  const opts = {
    hostname: "127.0.0.1",
    port: PAPERCLIP_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      "x-forwarded-host": req.headers.host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.socket.remoteAddress,
    },
  };

  const upstream = httpRequest(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  upstream.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Paperclip is restarting — please refresh in a moment.");
  });

  req.pipe(upstream, { end: true });
}

// ── Env var status (for setup page) ──────────────────────────────────────────

function envVarStatus() {
  const all = [
    { key: "DATABASE_URL", required: true, label: "Database URL", example: "postgresql://user:pass@host:5432/db" },
    { key: "BETTER_AUTH_SECRET", required: true, label: "Auth Secret", example: "${{secret(32)}} — use Railway generator" },
    { key: "PAPERCLIP_PUBLIC_URL", required: true, label: "Public URL", example: "https://your-app.up.railway.app" },
    { key: "PAPERCLIP_ALLOWED_HOSTNAMES", required: true, label: "Allowed Hostnames", example: "your-app.up.railway.app" },
    { key: "PAPERCLIP_DEPLOYMENT_MODE", required: false, label: "Deployment Mode", example: "authenticated" },
    { key: "PAPERCLIP_HOME", required: false, label: "Paperclip Home", example: "/paperclip" },
    { key: "ANTHROPIC_API_KEY", required: false, label: "Anthropic API Key", example: "sk-ant-..." },
    { key: "OPENAI_API_KEY", required: false, label: "OpenAI API Key", example: "sk-..." },
    { key: "GEMINI_API_KEY", required: false, label: "Gemini API Key", example: "AIza... (GOOGLE_API_KEY also accepted)" },
  ];
  return all.map(v => ({
    ...v,
    set: !!process.env[v.key],
    missing: v.required && !process.env[v.key],
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const ready = isReady();

    // ── Setup API routes (always available) ──────────────────────────────────

    if (path === "/setup/status" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        vars: envVarStatus(),
        configExists: existsSync(CONFIG_PATH),
        paperclipReady: paperclipReady,
        ready: ready,
      }));
      return;
    }

    if (path === "/setup/invite" && method === "GET") {
      // Try loading from memory, then file
      if (!inviteUrl && existsSync(INVITE_FILE)) {
        try { inviteUrl = stripAnsi(readFileSync(INVITE_FILE, "utf8")).trim(); } catch (_) { }
      }
      if (!bootstrapSkippedReason && existsSync(SKIP_REASON_FILE)) {
        try { bootstrapSkippedReason = readFileSync(SKIP_REASON_FILE, "utf8").trim(); } catch (_) { }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: inviteUrl,
        paperclipReady,
        skippedReason: bootstrapSkippedReason || null,
      }));
      return;
    }

    if (path === "/setup/launch" && method === "POST") {
      if (paperclipProc) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, already: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => startPaperclip(), 300);
      return;
    }

    if (path === "/setup/rotate-invite" && method === "POST") {
      generateBootstrapInvite(true).then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: inviteUrl }));
      });
      return;
    }

    if (path === "/setup/reset" && method === "POST") {
      resetSetup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Setup page ────────────────────────────────────────────────────────────

    if (path === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(join(__dirname, "setup.html"), "utf8"));
      return;
    }

    // ── Root + everything else ────────────────────────────────────────────────

    if (!ready) {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    proxy(req, res);
  });

  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`\n🔧 Wrapper listening on port ${PUBLIC_PORT}`);
    console.log(`   Visit /setup to configure or manage your instance.\n`);
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

const shouldSeedGeminiConfig =
  process.env.SEED_GEMINI_CONFIG === "1" ||
  process.env.SEED_GEMINI_CONFIG === "true" ||
  !!process.env.RAILWAY_PROJECT_ID ||
  !!process.env.RAILWAY_SERVICE_ID;

updatePaperclip();
if (shouldSeedGeminiConfig) {
  seedGeminiConfig();
}
startServer();

if (isReady()) {
  startPaperclip();
}
