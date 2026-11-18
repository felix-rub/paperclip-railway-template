import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enforceOpenRouterRecovery } from "../../scripts/openrouter-recovery.mjs";
import { createServerAdapter } from "./index.mjs";

const model = {
  id: "openrouter/free", context_length: 128_000,
  top_provider: { max_completion_tokens: 8192 },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "reasoning"],
};
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) }, type: "function" });

test("Pi executes scoped issue tools, rejects failed checks, handles >128KiB prompts, and aborts loops", {
  skip: process.env.OPENROUTER_PI_INTEGRATION !== "1", timeout: 60_000,
}, async () => {
  enforceOpenRouterRecovery();
  const runtime = await import("@paperclipai/adapter-pi-local/server");
  const cwd = await mkdtemp(join(tmpdir(), "openrouter-test-"));
  if (process.env.OPENROUTER_TEST_SHELL_PATH) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellPath: process.env.OPENROUTER_TEST_SHELL_PATH }));
  }
  const issueId = randomUUID();
  const writes = [];
  const requests = [];
  const authHeaders = [];
  let step = 0;
  let sequence = [];
  let failureStatus;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === `/api/issues/${issueId}`) {
      if (req.method === "PATCH") writes.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ title: "Test", description: "Synthetic fixture",
        status: req.method === "PATCH" ? JSON.parse(body).status : "todo" }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    authHeaders.push(req.headers.authorization);
    const parsedBody = JSON.parse(body);
    requests.push(parsedBody);
    if (parsedBody.reasoning?.effort === "none" || parsedBody.reasoning_effort === "none") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "Reasoning is mandatory for this endpoint and cannot be disabled." } }));
      return;
    }
    if (failureStatus) {
      res.writeHead(failureStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: failureStatus, message: "Free quota exhausted (synthetic fixture)." } }));
      return;
    }
    const tool = sequence[step++];
    const common = { id: `test-${step}`, object: "chat.completion.chunk", created: 1, model: model.id };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...(tool ?
        { tool_calls: [{ ...tool, index: 0, id: `tool-${step}` }] } : { content: "Completed turn." }) },
      finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify({ ...common, ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const oldUrl = process.env.PAPERCLIP_API_URL;
  process.env.PAPERCLIP_API_URL = base;
  try {
    const adapter = createServerAdapter({
      fetchImpl: async () => Response.json({ data: [model] }),
      runtime: { ...runtime, execute(ctx) {
        const providers = JSON.parse(ctx.config.env.PAPERCLIP_PI_PROVIDERS);
        providers.openrouter.baseUrl = `${base}/v1`;
        ctx.config.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
        return runtime.execute(ctx);
      } },
    });
    async function run(verificationCommand, calls, overrides = {}, extraContext = {}) {
      sequence = calls;
      step = 0;
      let capturedMeta;
      const runResult = await adapter.execute({
        runId: randomUUID(), agent: { id: randomUUID(), companyId: randomUUID(), name: "Fixture" },
        runtime: {}, context: { taskId: issueId, ...extraContext }, authToken: "fixture-token",
        config: { profile: "compact", verificationCommand, cwd, model: model.id, timeoutSec: 20,
          env: { OPENROUTER_API_KEY: "fixture-key" }, ...overrides },
        onLog: async () => {},
        onMeta: async meta => { capturedMeta = meta; },
      });
      return { ...runResult, capturedMeta };
    }
    const getTask = call("paperclip_get_task", {});
    const done = call("paperclip_set_status", { status: "done", evidence: "Check passed." });
    const blocked = call("paperclip_set_status", { status: "blocked", evidence: "Check failed." });
    const bash = command => call("bash", { command });
    const ok = await run("printf 'ok\\n'", [getTask, bash("printf 'ok\\n'"), done]);
    assert.equal(ok.exitCode, 0, `${ok.errorMessage}; ${ok.resultJson?.stderr}; ${ok.resultJson?.stdout?.split("\n").filter(line => line.includes('"type":"tool_execution_end"')).join("\n")}`);
    assert.equal(step, 3);
    assert.deepEqual(writes, [{ status: "done", comment: "Check passed." }]);
    assert.equal(authHeaders[0], "Bearer fixture-key");
    assert.equal(requests[0].model, "openrouter/free");
    assert.equal(requests[0].models, undefined);
    assert.equal(requests[0].reasoning, undefined);
    assert.equal(requests[0].store, undefined);
    assert.equal(requests[0].messages[0].role, "system");
    assert.equal(requests[0].provider.require_parameters, undefined);
    assert.deepEqual(requests[0].provider.max_price, { prompt: 0, completion: 0 });
    const failed = await run("exit 7", [getTask, bash("exit 7"), done, blocked]);
    assert.equal(failed.exitCode, 0, failed.errorMessage);
    assert.deepEqual(writes.map(write => write.status), ["done", "blocked"]);
    const repeat = call("ls", { path: "." });
    const loop = await run("exit 7", [repeat, repeat, repeat]);
    assert.equal(loop.errorCode, "openrouter_tool_loop", loop.errorMessage);
    assert.equal(step, 3);
    assert.equal(writes.length, 2);
    const largeInstructionsPath = join(cwd, "AGENTS.md");
    const largeSystemMarker = "LARGE_SYSTEM_MARKER_991";
    const largeUserMarker = "LARGE_USER_MARKER_992";
    await writeFile(largeInstructionsPath, `${largeSystemMarker}\n${"S".repeat(150_000)}\n`, "utf8");
    const standard = await run("", [], {
      profile: "standard", model: "openai/paid", fallbackModels: "anthropic/paid", escalationModel: "example/paid",
      instructionsFilePath: largeInstructionsPath,
      promptTemplate: `${largeUserMarker}\n${"U".repeat(150_000)}`,
    });
    assert.equal(standard.exitCode, 0, `${standard.errorMessage}; ${standard.resultJson?.stderr}`);
    assert.ok(standard.capturedMeta.commandArgs.every(arg => Buffer.byteLength(arg, "utf8") < 4096),
      "No CLI argv element may carry large system or user prompts (Linux MAX_ARG_STRLEN=131072).");
    const lastRequest = requests.at(-1);
    assert.equal(lastRequest.model, "openrouter/free");
    assert.equal(lastRequest.models, undefined);
    assert.deepEqual(lastRequest.provider.max_price, { prompt: 0, completion: 0 });
    assert.match(JSON.stringify(lastRequest.messages), new RegExp(largeSystemMarker));
    assert.match(JSON.stringify(lastRequest.messages), new RegExp(largeUserMarker));
    failureStatus = 429;
    const before = requests.length;
    const quota = await run("exit 7", []);
    assert.notEqual(quota.exitCode, 0);
    assert.equal(requests.length - before, 1, "Quota failure must return to the durable hourly scheduler, not retry immediately.");
  } finally {
    if (oldUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldUrl;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(cwd, { force: true, recursive: true });
  }
});
