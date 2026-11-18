import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerAdapter } from "./index.mjs";
import { createCatalog, toRuntimeModel } from "./catalog.mjs";
import { assertHarnessTestPassed } from "../../node_modules/@paperclipai/server/dist/services/agent-harness-verification.js";
import { createGuard, createIssueTools, routeRequest } from "./policy.mjs";

const model = {
  id: "example/tool-model", name: "Example tool model",
  context_length: 128_000,
  top_provider: { max_completion_tokens: 8192 },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
  supported_parameters: ["tools", "reasoning"],
};
const fakeKey = "test-only-not-a-real-credential";
const fetchCatalog = async () => ({ ok: true, json: async () => ({ data: [model] }) });

test("compact completion requires the exact successful check after changes", async () => {
  const state = {};
  const issueId = "11111111-2222-4333-8444-555555555555";
  const requests = [];
  const verificationCommand = "npm test";
  const issue = createIssueTools({
    env: { PAPERCLIP_API_URL: "http://localhost:3000/api/", PAPERCLIP_API_KEY: fakeKey, PAPERCLIP_RUN_ID: "run" },
    issueId, verificationCommand, state,
    fetchImpl: async (url, options) => {
      requests.push([url, JSON.parse(options.body), options.headers["X-Paperclip-Run-Id"]]);
      return Response.json({ status: JSON.parse(options.body).status });
    },
  });
  const guard = createGuard({ verificationCommand, maxToolCalls: 30, maxRunInputTokens: 200 }, state);
  const done = { status: "done", evidence: "Tests passed." };
  await assert.rejects(issue.setStatus(done), /verification command/);
  guard.beforeTool({ toolName: "bash", toolCallId: "1", input: { command: verificationCommand } });
  guard.afterTool({ toolCallId: "1", isError: true });
  await assert.rejects(issue.setStatus(done), /verification command/);
  guard.beforeTool({ toolName: "bash", toolCallId: "2", input: { command: verificationCommand } });
  guard.afterTool({ toolCallId: "2", isError: false });
  guard.beforeTool({ toolName: "write", toolCallId: "3", input: { path: "file" } });
  guard.afterTool({ toolCallId: "3", isError: false });
  await assert.rejects(issue.setStatus(done), /verification command/);
  assert.deepEqual(requests, []);
  await issue.setStatus({ status: "blocked", evidence: "Dependency unavailable." });
  assert.deepEqual(requests, [[`http://localhost:3000/api/issues/${issueId}`,
    { status: "blocked", comment: "Dependency unavailable." }, "run"]]);
  await assert.rejects(issue.setStatus(done), /already submitted/);
});

test("compact guard blocks the third duplicate and counts cached input against budget", () => {
  const state = {};
  const guard = createGuard({ maxToolCalls: 30, maxRunInputTokens: 100 }, state);
  const event = { toolName: "read", input: { path: "a" } };
  assert.equal(guard.beforeTool(event), undefined);
  assert.equal(guard.beforeTool(event), undefined);
  assert.equal(guard.beforeTool(event).block, true);
  assert.equal(state.stop, "openrouter_tool_loop");
  const budgetState = {};
  createGuard({ maxToolCalls: 30, maxRunInputTokens: 100 }, budgetState)
    .afterMessage({ role: "assistant", usage: { input: 20, cacheRead: 80 } });
  assert.equal(budgetState.stop, "openrouter_input_budget");
});

test("routing requests an ordered fallback and preserves provider-specific cache markers", () => {
  const payload = {
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "system", content: [{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } }] }],
  };
  const routed = routeRequest(payload, ["example/tool-model"]);
  assert.deepEqual(routed.models, [payload.model, "example/tool-model"]);
  assert.equal(routed.provider.require_parameters, true);
  assert.deepEqual(routed.messages, payload.messages);
});

test("adapter routes exclusively to OpenRouter and preserves lifecycle, session and usage hooks", async () => {
  const controller = new AbortController();
  const usage = { inputTokens: 11, outputTokens: 7 };
  const result = { exitCode: 0, usage, provider: "openrouter", sessionParams: { sessionId: "session" } };
  const runtime = {
    sessionCodec: { serialize: value => value },
    async execute(ctx) {
      assert.equal(ctx.signal, controller.signal);
      assert.equal(ctx.config.command, "pi");
      assert.equal(ctx.config.model, "openrouter/example/tool-model");
      assert.equal(ctx.config.env.OPENROUTER_API_KEY, fakeKey);
      const providers = JSON.parse(ctx.config.env.PAPERCLIP_PI_PROVIDERS);
      assert.deepEqual(Object.keys(providers), ["openrouter"]);
      assert.equal(providers.openrouter.baseUrl, "https://openrouter.ai/api/v1");
      assert.equal(providers.openrouter.apiKey, "OPENROUTER_API_KEY");
      assert.equal(providers.openrouter.models[0].cost.input, 1);
      assert.equal(providers.openrouter.models[0].cost.output, 2);
      assert.equal(providers.openrouter.models[0].maxTokens, 256);
      assert.equal(providers.openrouter.models[0].contextWindow, 128_000);
      assert.equal(ctx.config.timeoutSec, 300);
      await ctx.onMeta({ adapterType: "pi_local", command: "pi" });
      await ctx.onUsage(usage);
      return result;
    },
  };
  const adapter = createServerAdapter({ runtime, fetchImpl: fetchCatalog });
  let metadata;
  let receivedUsage;
  assert.equal(adapter.type, "openrouter");
  assert.equal(adapter.sessionCodec, runtime.sessionCodec);
  assert.equal(await adapter.execute({
    config: { model: model.id, maxOutputTokens: 256, env: { OPENROUTER_API_KEY: fakeKey } },
    signal: controller.signal,
    onMeta: async value => { metadata = value; },
    onUsage: async value => { receivedUsage = value; },
  }), result);
  assert.equal(metadata.adapterType, "openrouter");
  assert.equal(receivedUsage, usage);
});

test("missing and unresolved credentials fail before discovery or provider execution", async () => {
  const adapter = createServerAdapter({
    fetchImpl: () => assert.fail("must not fetch without a usable credential"),
    runtime: { execute: () => assert.fail("must not run") },
  });
  for (const key of ["", { type: "secret_ref", secretId: "not-resolved" }]) {
    const logs = [];
    const result = await adapter.execute({
      config: { model: model.id, env: { OPENROUTER_API_KEY: key } },
      onLog: async (_, text) => logs.push(text),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, "configuration_incomplete");
    assert.match(result.errorMessage, /OPENROUTER_API_KEY is missing/);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs.join(""), /not-resolved/);
  }
});

test("model catalog filters incompatible models, caches, and refreshes without credentials", async () => {
  let calls = 0;
  const catalog = createCatalog(async (url, options) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(options.headers, undefined);
    return {
      ok: true,
      json: async () => ({ data: [model, { ...model, id: "example/no-tools", supported_parameters: [] }] }),
    };
  });
  assert.deepEqual(await catalog.list(), [{ id: model.id, label: model.name }]);
  assert.equal((await catalog.resolve(`openrouter/${model.id}`)).id, model.id);
  assert.equal(calls, 1);
  await catalog.list(true);
  assert.equal(calls, 2);
  await assert.rejects(catalog.resolve("example/no-tools"), /unavailable or does not support tools/);
});

test("catalog errors and unknown pricing are explicit, not empty lists or zero-cost success", async () => {
  const failed = createCatalog(async () => ({ ok: false, status: 503 }));
  await assert.rejects(failed.list(), /HTTP 503/);
  await assert.rejects(createCatalog(async () => ({ ok: true, json: async () => ({}) })).list(), /invalid model catalog/);
  assert.throws(() => toRuntimeModel({ ...model, pricing: {} }), /invalid input pricing/);
  assert.throws(() => toRuntimeModel({ ...model, top_provider: {} }), /context\/output limits/);
});

test("OpenRouter's free router runs with null completion limits and respects a lower agent cap", async () => {
  const free = { ...model, id: "openrouter/free", context_length: 200_000,
    top_provider: { context_length: null, max_completion_tokens: null },
    pricing: { prompt: "0", completion: "0" } };
  const seen = [];
  const adapter = createServerAdapter({
    fetchImpl: async () => Response.json({ data: [free] }),
    runtime: { async execute({ config }) {
      const [runtimeModel] = JSON.parse(config.env.PAPERCLIP_PI_PROVIDERS).openrouter.models;
      seen.push([config.model, runtimeModel.id, runtimeModel.contextWindow, runtimeModel.maxTokens, runtimeModel.cost.output]);
      return { exitCode: 0 };
    } },
  });
  for (const [model, maxOutputTokens] of [["openrouter/free", 8192], ["openrouter/openrouter/free", 512]]) {
    const result = await adapter.execute({
      config: { model, maxOutputTokens, env: { OPENROUTER_API_KEY: fakeKey } },
      onLog: async () => {},
    });
    assert.equal(result.exitCode, 0, result.errorMessage);
  }
  assert.deepEqual(seen, [
    ["openrouter/openrouter/free", "openrouter/free", 200_000, 4096, 0],
    ["openrouter/openrouter/free", "openrouter/free", 200_000, 512, 0],
  ]);
  assert.throws(() => toRuntimeModel({ ...free, id: "openrouter/auto" }), /context\/output limits/);
  assert.throws(() => toRuntimeModel({ ...free, pricing: { prompt: "-1", completion: "-1" } }), /invalid input pricing/);
});

test("incompatible reasoning and provider-overriding arguments never execute", async () => {
  const adapter = createServerAdapter({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ ...model, supported_parameters: ["tools"] }] }) }),
    runtime: { execute: () => assert.fail("must not run") },
  });
  for (const overrides of [{ thinking: "high" }, { extraArgs: ["--provider", "openai"] }, { timeoutSec: -1 }, { timeoutSec: "0" }]) {
    const result = await adapter.execute({
      config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey }, ...overrides },
      onLog: async () => {},
    });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fakeKey));
  }
});

test("Paperclip's zero timeout sentinel uses the bounded profile default", async () => {
  const timeouts = [];
  const adapter = createServerAdapter({
    fetchImpl: fetchCatalog,
    runtime: { async execute({ config }) {
      timeouts.push(config.timeoutSec);
      return { exitCode: 0 };
    } },
  });
  for (const [profile, timeoutSec] of [["standard", 0], ["compact", 0], ["standard", 45]]) {
    const result = await adapter.execute({
      config: { profile, timeoutSec, model: model.id, env: { OPENROUTER_API_KEY: fakeKey } },
      context: {},
      onLog: async () => {},
    });
    assert.equal(result.exitCode, 0, result.errorMessage);
  }
  assert.deepEqual(timeouts, [300, 600, 45]);
});

test("environment probe reports the OpenRouter adapter identity and prepared provider config", async () => {
  let tested = false;
  let summary = "hello";
  const adapter = createServerAdapter({
    fetchImpl: fetchCatalog,
    runtime: {
      async execute(ctx) {
        tested = true;
        assert.equal(ctx.config.model, `openrouter/${model.id}`);
        const providers = JSON.parse(ctx.config.env.PAPERCLIP_PI_PROVIDERS);
        assert.equal(providers.openrouter.models[0].maxTokens, 256);
        assert.equal(ctx.config.timeoutSec, 60);
        assert.deepEqual(ctx.config.extraArgs, ["--tools", "read", "--no-session"]);
        return { exitCode: 0, summary };
      },
    },
  });
  const result = await adapter.testEnvironment({ config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey } } });
  assert.equal(tested, true);
  assert.equal(result.adapterType, "openrouter");
  assert.equal(result.status, "pass");
  assert.doesNotThrow(() => assertHarnessTestPassed(result));
  summary = "Unexpected response";
  const unexpected = await adapter.testEnvironment({ config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey } } });
  assert.equal(unexpected.status, "warn");
  assert.throws(() => assertHarnessTestPassed(unexpected), { code: "harness_probe_unexpected_output" });
  const missing = await adapter.testEnvironment({ config: { model: model.id, env: { OPENROUTER_API_KEY: "" } } });
  assert.equal(missing.status, "fail");
  assert.equal(missing.checks[0].level, "error");
});

test("environment probe reports provider failures without leaking credentials", async () => {
  const adapter = createServerAdapter({
    fetchImpl: fetchCatalog,
    runtime: { execute: async () => ({ exitCode: 1, errorMessage: `Rejected credential ${fakeKey}` }) },
  });
  const result = await adapter.testEnvironment({ config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey } } });
  assert.equal(result.status, "fail");
  assert.match(result.checks[0].message, /Rejected credential \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fakeKey));
});

test("configuration schema lists OpenRouter models without a plaintext key field", async () => {
  const adapter = createServerAdapter({ fetchImpl: fetchCatalog });
  const schema = await adapter.getConfigSchema();
  assert.deepEqual(schema.fields.find(field => field.key === "model").options, [{ value: model.id, label: model.name }]);
  assert.equal(schema.fields.some(field => /^(?:apiKey|key|token|password|secret|OPENROUTER_API_KEY)$/i.test(field.key)), false);
});
