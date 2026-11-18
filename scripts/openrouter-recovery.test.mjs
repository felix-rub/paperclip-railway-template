import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openRouterRetryOptions, patchOpenRouterSources, OPENROUTER_RETRY_MS } from "./openrouter-recovery.mjs";

test("OpenRouter retries use the persisted failure clock, never exponential backoff or a finite budget", () => {
  const finishedAt = new Date("2026-11-18T10:00:00Z");
  const agent = { adapterType: "openrouter" };
  const run = { finishedAt, scheduledRetryAttempt: 1_000_000 };
  for (const elapsed of [0, OPENROUTER_RETRY_MS - 1, OPENROUTER_RETRY_MS, OPENROUTER_RETRY_MS + 1]) {
    const now = new Date(+finishedAt + elapsed);
    const options = openRouterRetryOptions(run, agent, { now, maxAttempts: 2, delayMs: 1 });
    assert.equal(options.delayMs, Math.max(0, OPENROUTER_RETRY_MS - elapsed));
    assert.equal(options.maxAttempts, Infinity);
  }
  const options = { delayMs: 30_000, maxAttempts: 2 };
  assert.equal(openRouterRetryOptions(run, { adapterType: "codex_local" }, options), options);
  assert.throws(() => openRouterRetryOptions({ finishedAt: "invalid" }, agent), /timestamp/);
});

test("patch matches installed upstream, installs every hook, and remains idempotent", () => {
  const server = "../node_modules/@paperclipai/server/dist/services/";
  const sources = {
    retries: readFileSync(new URL(`${server}heartbeat/retries.js`, import.meta.url), "utf8"),
    completion: readFileSync(new URL(`${server}heartbeat/run-completion.js`, import.meta.url), "utf8"),
    recovery: readFileSync(new URL(`${server}recovery/service.js`, import.meta.url), "utf8"),
    pi: readFileSync(new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/runtime-config.js", import.meta.url), "utf8"),
    conversation: readFileSync(new URL(`${server}conversation-continuation.js`, import.meta.url), "utf8"),
    queue: readFileSync(new URL(`${server}heartbeat/queue.js`, import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js", import.meta.url), "utf8"),
  };
  const patched = patchOpenRouterSources(sources);
  assert.deepEqual(patchOpenRouterSources(patched), patched);
  assert.match(patched.retries, /opts = openRouterRetryOptions/);
  assert.match(patched.completion, /"failed", "timed_out", "interrupted"/);
  assert.match(patched.recovery, /await reconcileOpenRouterRetries/);
  assert.match(patched.pi, /retry: \{ enabled: false, maxRetries: 0, provider: \{ maxRetries: 0 \} \}/);
  const changed = { ...sources, retries: "unexpected upstream implementation" };
  assert.throws(() => patchOpenRouterSources(changed), /no longer matches upstream/);
  assert.equal(changed.retries, "unexpected upstream implementation");
});
