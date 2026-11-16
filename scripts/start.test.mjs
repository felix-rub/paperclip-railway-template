import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { enforceAgentRetryPolicy, enforceGeminiAcpModelCompatibility, watchPaperclipReadiness } from "./start.mjs";

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
