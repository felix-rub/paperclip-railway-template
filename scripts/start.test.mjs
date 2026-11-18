import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { attachUpgradeProxy } from "./proxy-upgrade.mjs";
import { enforceAgentRetryPolicy, enforceGeminiAcpModelCompatibility, watchPaperclipReadiness } from "./start.mjs";
import { patchBundledZod } from "./patch-bundled-zod.mjs";

const recovery = `export function classifyAdapterFailureForRecovery(latestRun) {
    if (latestRun.errorCode === "adapter_engine_unavailable" || latestRun.errorCode === "provider_tool_definition_invalid" || latestRun.errorCode === "native_provider_model_rejected") {
        return { kind: "configuration_incomplete" };
    }
    if (latestRun.errorCode === "configuration_incomplete" ||
        CONFIGURATION_INCOMPLETE_ERROR_RE.test(error)) {
        return { kind: "configuration_incomplete" };
    }
}
export function classifyContinuationFailure(latestRun) {
    return {
            kind: "non_retryable",
            maxAttempts: 0,
            baseBackoffMs: 0,
            errorCode,
        };
    maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
            baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
        baseBackoffMs: 0,
    const requiredDelay = classification.baseBackoffMs *
                            Math.pow(2, Math.max(0, consecutive - 1));
    const retryAt = readProviderQuotaRetryAt(input.latestRun, now);
}`;

const gemini = `if (requestedModel && acpxAgent === "gemini") {
        env.GEMINI_MODEL = requestedModel;
    }
function sessionConfigOptions(prepared) {
    const options = [];
    if (prepared.requestedModel &&
        prepared.acpxAgent !== "claude" &&
        prepared.acpxAgent !== "codex" &&
        prepared.acpxAgent !== "gemini") {
        options.push({ key: "model", value: prepared.requestedModel });
    }
    if (prepared.requestedThinkingEffort && prepared.acpxAgent !== "codex") {
        options.push({ key: "effort", value: prepared.requestedThinkingEffort });
    }
    if (prepared.fastMode && prepared.acpxAgent !== "codex") {
        options.push({ key: "service_tier", value: "fast" });
    }
    return options;
}`;

function withFile(source, run) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-patch-"));
  const path = join(dir, "source.js");
  try {
    writeFileSync(path, source);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("retry patch supports current upstream and is idempotent", () => {
  withFile(recovery, path => {
    enforceAgentRetryPolicy(path);
    const patched = readFileSync(path, "utf8");
    assert.doesNotMatch(patched, /return \{ kind: "configuration_incomplete" \}/);
    assert.match(patched, /kind: "default",\s+maxAttempts: Number\.MAX_SAFE_INTEGER,\s+baseBackoffMs: 60_000/);
    assert.match(patched, /const requiredDelay = classification\.baseBackoffMs;/);
    assert.match(patched, /const retryAt = new Date\(now\.getTime\(\) \+ 60_000\);/);
    enforceAgentRetryPolicy(path);
    assert.equal(readFileSync(path, "utf8"), patched);
  });
});

test("unknown recovery changes fail without writing a partial patch", () => {
  const changed = recovery.replace('return { kind: "configuration_incomplete" };', 'return { kind: "new_blocker" };');
  withFile(changed.replace("maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,", "unknown upstream change"), path => {
    assert.throws(() => enforceAgentRetryPolicy(path), /retry-policy patch/);
    assert.equal(readFileSync(path, "utf8"), changed.replace("maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,", "unknown upstream change"));
  });
});

test("retry patch supports the previous upstream formatting", () => {
  const legacy = recovery
    .replace(`    if (latestRun.errorCode === "adapter_engine_unavailable" || latestRun.errorCode === "provider_tool_definition_invalid" || latestRun.errorCode === "native_provider_model_rejected") {
        return { kind: "configuration_incomplete" };
    }
`, "")
    .replace('latestRun.errorCode === "configuration_incomplete" ||\n        CONFIGURATION_INCOMPLETE_ERROR_RE', 'latestRun.errorCode === "configuration_incomplete" || CONFIGURATION_INCOMPLETE_ERROR_RE')
    .replace(`return {
            kind: "non_retryable",
            maxAttempts: 0,
            baseBackoffMs: 0,
            errorCode,
        };`, 'return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };');
  withFile(legacy, path => {
    enforceAgentRetryPolicy(path);
    const patched = readFileSync(path, "utf8");
    assert.doesNotMatch(patched, /return \{ kind: "configuration_incomplete" \}/);
    enforceAgentRetryPolicy(path);
    assert.equal(readFileSync(path, "utf8"), patched);
  });
});

test("Gemini uses upstream startup model and skips unsupported ACP options", () => {
  withFile(gemini, path => {
    enforceGeminiAcpModelCompatibility(path);
    const patched = readFileSync(path, "utf8");
    assert.match(patched, /env\.GEMINI_MODEL = requestedModel/);
    assert.match(patched, /prepared\.requestedThinkingEffort && prepared\.acpxAgent !== "codex" && prepared\.acpxAgent !== "gemini"/);
    assert.match(patched, /prepared\.fastMode && prepared\.acpxAgent !== "codex" && prepared\.acpxAgent !== "gemini"/);
    enforceGeminiAcpModelCompatibility(path);
    assert.equal(readFileSync(path, "utf8"), patched);
  });
});

test("readiness waits for a successful health response", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/health");
    requests++;
    res.writeHead(requests === 1 ? 503 : 200);
    res.end(JSON.stringify({ status: requests < 3 ? "starting" : "ok" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cancel(); reject(new Error("health check timed out")); }, 2000);
      const cancel = watchPaperclipReadiness(server.address().port, () => {
        clearTimeout(timeout);
        resolve();
      }, 10);
    });
    assert.ok(requests >= 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("replaces vulnerable bundled Zod and preserves newer versions", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-zod-"));
  const source = join(root, "node_modules", "zod");
  const bundled = join(root, "node_modules", "@paperclipai", "server", "node_modules", "zod");
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(bundled, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ overrides: { zod: "4.6.7" } }));
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: "4.6.7" }));
    writeFileSync(join(source, "fixed.js"), "fixed");
    writeFileSync(join(bundled, "package.json"), JSON.stringify({ version: "4.4.3" }));
    writeFileSync(join(bundled, "obsolete.js"), "old");
    patchBundledZod(root);
    assert.equal(JSON.parse(readFileSync(join(bundled, "package.json"))).version, "4.6.7");
    assert.equal(readFileSync(join(bundled, "fixed.js"), "utf8"), "fixed");
    assert.throws(() => readFileSync(join(bundled, "obsolete.js")));
    writeFileSync(join(bundled, "package.json"), JSON.stringify({ version: "4.7.0" }));
    patchBundledZod(root);
    assert.equal(JSON.parse(readFileSync(join(bundled, "package.json"))).version, "4.7.0");
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: "4.4.3" }));
    assert.throws(() => patchBundledZod(root), /Cannot safely update/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function upgradeServers(t, ready, handleUpgrade) {
  const sockets = new Set();
  const upstream = createServer();
  upstream.on("upgrade", handleUpgrade);
  const proxy = createServer();
  for (const server of [upstream, proxy]) {
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([upstream, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  attachUpgradeProxy(proxy, { port: upstream.address().port, ready: () => ready });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return () => request({
    hostname: "127.0.0.1", port: proxy.address().port, path: "/events/ws",
    headers: { Connection: "Upgrade", Upgrade: "websocket", Cookie: "session=test" },
  });
}

test("WebSocket proxy preserves authentication headers and bidirectional bytes", { timeout: 5000 }, async t => {
  let received;
  const makeRequest = await upgradeServers(t, true, (req, socket) => {
    received = req.headers;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nserver-head");
    socket.on("data", data => socket.write(data));
  });
  const req = makeRequest();
  const upgraded = once(req, "upgrade");
  req.end();
  const [response, socket, head] = await upgraded;
  t.after(() => socket.destroy());
  assert.equal(response.statusCode, 101);
  assert.equal(received.cookie, "session=test");
  assert.equal(received["x-forwarded-proto"], "https");
  assert.ok(received["x-forwarded-host"].startsWith("127.0.0.1:"));
  assert.equal(head.toString(), "server-head");
  const reply = once(socket, "data");
  socket.write("client-roundtrip");
  assert.equal((await reply)[0].toString(), "client-roundtrip");
});

test("WebSocket proxy preserves upstream authentication failures", { timeout: 5000 }, async t => {
  const makeRequest = await upgradeServers(t, true, (_, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const req = makeRequest();
  const response = once(req, "response");
  req.end();
  const [res] = await response;
  assert.equal(res.statusCode, 401);
  res.resume();
});

test("WebSocket proxy refuses upgrades before Paperclip is ready", { timeout: 5000 }, async t => {
  const makeRequest = await upgradeServers(t, false, () => assert.fail("not ready"));
  const req = makeRequest();
  const response = once(req, "response");
  req.end();
  const [res] = await response;
  assert.equal(res.statusCode, 503);
  res.resume();
});

test("WebSocket proxy bounds a stalled upstream handshake", { timeout: 20000 }, async t => {
  const makeRequest = await upgradeServers(t, true, () => {});
  const req = makeRequest();
  const response = once(req, "response");
  req.end();
  const [res] = await response;
  assert.equal(res.statusCode, 502);
  res.resume();
});
