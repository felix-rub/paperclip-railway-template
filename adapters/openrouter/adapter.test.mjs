import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerAdapter } from "./index.mjs";
import { createCatalog, toRuntimeModel } from "./catalog.mjs";

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

test("incompatible reasoning and provider-overriding arguments never execute", async () => {
  const adapter = createServerAdapter({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ ...model, supported_parameters: ["tools"] }] }) }),
    runtime: { execute: () => assert.fail("must not run") },
  });
  for (const overrides of [{ thinking: "high" }, { extraArgs: ["--provider", "openai"] }, { timeoutSec: 0 }]) {
    const result = await adapter.execute({
      config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey }, ...overrides },
      onLog: async () => {},
    });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fakeKey));
  }
});

test("environment probe reports the OpenRouter adapter identity and prepared provider config", async () => {
  let tested = false;
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
        return { exitCode: 0, summary: "hello" };
      },
    },
  });
  const result = await adapter.testEnvironment({ config: { model: model.id, env: { OPENROUTER_API_KEY: fakeKey } } });
  assert.equal(tested, true);
  assert.equal(result.adapterType, "openrouter");
  assert.equal(result.status, "pass");
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
