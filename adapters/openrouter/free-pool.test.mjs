import assert from "node:assert/strict";
import { test } from "node:test";
import { limitOpenRouterAvailableSlots } from "../../scripts/openrouter-recovery.mjs";
import { classifyFailure, createFreePool, GEMINI_DUMMY_SIGNATURE, toGeminiRequest } from "./free-pool.mjs";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const freeTier429 = JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [
  { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
] } }]);
const sse = chunks => new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });

function fakeUpstream({ tier = "free", handlers }) {
  const calls = [];
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    if (url === GEMINI && body.max_completion_tokens === 1 && body.messages[0].content === "ok") {
      return tier === "free" ? new Response(freeTier429, { status: 429 }) : Response.json({ choices: [] });
    }
    calls.push({ url, body, auth: init.headers.Authorization });
    return handlers(url, body, calls.length);
  }
  return { calls, fetchImpl };
}

async function post(pool, token, body) {
  const response = await fetch(`${pool.baseUrl}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, lane: response.headers.get("x-free-pool-lane"), text: await response.text() };
}

const request = extra => ({ model: "openrouter/free", stream: true, provider: { max_price: { prompt: 0, completion: 0 } },
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }], ...extra });

test("pool fails over across free lanes, replays Gemini thought signatures and gates dispatch when exhausted", async () => {
  let clock = Date.parse("2026-05-01T10:00:00Z");
  const { calls, fetchImpl } = fakeUpstream({ handlers(url, body) {
    if (url === GEMINI && body.model === "m1") return new Response(freeTier429, { status: 429 });
    if (url === GEMINI && body.model === "m2") {
      if (body.messages.length === 1) {
        return sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
          function: { name: "read", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG-1" } } }] } }] }]);
      }
      return sse([{ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }]);
    }
    return new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } }), { status: 429 });
  } });
  const logs = [];
  const pool = createFreePool({ env: { GEMINI_API_KEY: "g-key", FREE_POOL_GEMINI_MODELS: "m1,m2" }, fetchImpl,
    log: entry => logs.push(entry), now: () => clock });
  await pool.start();
  try {
    const token = pool.issueToken({ openrouterKey: "or-key", runId: "run-1" });
    const first = await post(pool, token, request());
    assert.equal(first.status, 200);
    assert.equal(first.lane, "gemini/m2");
    assert.match(first.text, /SIG-1/);
    assert.deepEqual(calls.map(call => call.body.model), ["m1", "m2"]);
    assert.equal(calls[1].auth, "Bearer g-key");
    assert.equal(calls[1].body.provider, undefined, "OpenRouter routing fields must not reach Gemini");

    const followUp = request({ messages: [
      ...request().messages,
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "file" }] },
    ] });
    const second = await post(pool, token, followUp);
    assert.equal(second.status, 200);
    assert.equal(calls.at(-1).body.model, "m2", "the cooling lane is skipped");
    assert.equal(calls.at(-1).body.messages[1].tool_calls[0].extra_content.google.thought_signature, "SIG-1");
    assert.equal(calls.at(-1).body.messages[2].content, "file");

    assert.equal(await post(pool, "wrong", request()).then(r => r.status), 401);
    assert.equal(pool.exhaustedUntil(), 0);

    clock += 60 * 60 * 1000 + 1;
    const exhaustAll = createFreePool({ env: { GEMINI_API_KEY: "g-key", FREE_POOL_GEMINI_MODELS: "m1" }, now: () => clock,
      log: () => {}, fetchImpl: fakeUpstream({ handlers: (url, body) => (url === GEMINI && body.model === "m1"
        ? new Response(freeTier429, { status: 429 })
        : new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } }), { status: 429 })) }).fetchImpl });
    await exhaustAll.start();
    try {
      const exhaustedToken = exhaustAll.issueToken({ openrouterKey: "or-key" });
      const exhausted = await post(exhaustAll, exhaustedToken, request());
      assert.equal(exhausted.status, 429);
      assert.match(exhausted.text, /free-models-per-day/);
      const until = exhaustAll.exhaustedUntil();
      assert.ok(until > clock && until <= clock + 60 * 60 * 1000, "cooldowns are capped at one hour");
      const symbol = Symbol.for("paperclip.freePool");
      const previous = globalThis[symbol];
      globalThis[symbol] = { exhaustedUntil: () => Date.now() + 60_000 };
      try {
        const db = { execute: async () => { throw new Error("must not query while the pool is exhausted"); } };
        assert.equal(await limitOpenRouterAvailableSlots(db, { adapterType: "openrouter" }, 2, () => ""), 0);
      } finally {
        globalThis[symbol] = previous;
      }
    } finally {
      await exhaustAll.close();
    }
  } finally {
    await pool.close();
  }
  assert.ok(logs.some(entry => entry.event === "lane_cooldown" && entry.lane === "gemini/m1" && entry.reason === "quota_daily"));
});

test("Gemini lanes stay disabled unless the key is verified as free tier", async () => {
  const { calls, fetchImpl } = fakeUpstream({ tier: "billed", handlers: () => sse([
    { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]) });
  const pool = createFreePool({ env: { GEMINI_API_KEY: "g-key", FREE_POOL_GEMINI_MODELS: "m1" }, fetchImpl, log: () => {} });
  await pool.start();
  try {
    const result = await post(pool, pool.issueToken({ openrouterKey: "or-key" }), request());
    assert.equal(result.status, 200);
    assert.equal(result.lane, "openrouter/free");
    assert.deepEqual(calls.map(call => call.url), ["https://openrouter.ai/api/v1/chat/completions"]);
    assert.equal(calls[0].auth, "Bearer or-key");
    assert.equal(calls[0].body.model, "openrouter/free");
    assert.deepEqual(calls[0].body.provider.max_price, { prompt: 0, completion: 0 });
    assert.equal(pool.status().geminiTier, "billed");
  } finally {
    await pool.close();
  }
});

test("short per-minute cooldowns are waited out instead of failing the run", async () => {
  let clock = Date.parse("2026-05-01T10:00:00Z");
  let first = true;
  const { fetchImpl } = fakeUpstream({ handlers: (url) => {
    if (url === GEMINI && first) { first = false; return new Response("{}", { status: 503 }); }
    if (url === GEMINI) return sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
    return new Response(JSON.stringify({ error: { message: "free-models-per-day" } }), { status: 429 });
  } });
  const waits = [];
  const pool = createFreePool({ env: { GEMINI_API_KEY: "g-key", FREE_POOL_GEMINI_MODELS: "m1" }, fetchImpl, log: () => {},
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await pool.start();
  try {
    const result = await post(pool, pool.issueToken({ openrouterKey: "or-key" }), request());
    assert.equal(result.status, 200);
    assert.equal(result.lane, "gemini/m1");
    assert.equal(waits.length, 1);
  } finally {
    await pool.close();
  }
});

test("concurrent requests spread across distinct ready provider lanes", async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetchImpl } = fakeUpstream({ handlers: async (url, body) => {
    started.push(url === GEMINI ? body.model : "openrouter/free");
    if (started.length === 3) release();
    await gate;
    return sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
  } });
  const pool = createFreePool({
    env: { GEMINI_API_KEY: "g-key", FREE_POOL_GEMINI_MODELS: "m1,m2" },
    fetchImpl,
    log: () => {},
  });
  await pool.start();
  try {
    const results = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      post(pool, pool.issueToken({ openrouterKey: "or-key", runId: `run-${index}` }), request())));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(new Set(results.map(result => result.lane)).size, 3);
    assert.deepEqual(new Set(started), new Set(["m1", "m2", "openrouter/free"]));
  } finally {
    await pool.close();
  }
});

test("classifies failures and sanitizes Gemini payloads", () => {
  const now = Date.parse("2026-05-01T10:00:00Z");
  const gemini = { provider: "gemini" };
  assert.equal(classifyFailure(gemini, 429, freeTier429, null, now).reason, "quota_daily");
  assert.equal(classifyFailure(gemini, 429, JSON.stringify({ error: { message: "quota" } }), null, now).disableGemini, true);
  assert.equal(classifyFailure(gemini, 503, "{}", null, now).reason, "overloaded");
  assert.equal(classifyFailure(gemini, 400, JSON.stringify({ error: { message: "bad schema" } }), null, now).failover, false);
  assert.equal(classifyFailure(gemini, 400, "function_call_filter: MALFORMED_FUNCTION_CALL", null, now).reason, "malformed_tool_call");
  assert.equal(classifyFailure({ provider: "openrouter" }, 429, '{"error":{"message":"free-models-per-day"}}',
    new Headers(), now).cooldownUntil, now + 60 * 60 * 1000);
  const out = toGeminiRequest({
    model: "x", reasoning: { effort: "low" }, store: false, max_tokens: 100,
    messages: [
      { role: "developer", content: "sys" },
      { role: "assistant", content: [], reasoning_content: "hidden", tool_calls: [{ id: "a", function: { name: "f", arguments: "{}" } }] },
    ],
  }, "gemini-x");
  assert.deepEqual(Object.keys(out).sort(), ["max_completion_tokens", "messages", "model", "reasoning_effort"]);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content, null);
  assert.equal(out.messages[1].reasoning_content, undefined);
  assert.equal(out.messages[1].tool_calls[0].extra_content.google.thought_signature, GEMINI_DUMMY_SIGNATURE);
});
