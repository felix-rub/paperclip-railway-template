import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as runtime from "@paperclipai/adapter-pi-local/server";
import { createServerAdapter } from "./index.mjs";

const model = {
  id: "anthropic/claude-haiku-5.5", context_length: 128_000,
  top_provider: { max_completion_tokens: 8192 },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"],
};
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) }, type: "function" });

test("Pi executes scoped issue tools, rejects failed checks, and aborts loops", {
  skip: process.env.OPENROUTER_PI_INTEGRATION !== "1", timeout: 45_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openrouter-test-"));
  const issueId = randomUUID();
  const writes = [];
  const requests = [];
  let step = 0;
  let sequence = [];
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
    requests.push(JSON.parse(body));
    const tool = sequence[step++];
    const common = { id: `test-${step}`, object: "chat.completion.chunk", created: 1, model: model.id };
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", ...(tool ?
        { tool_calls: [{ ...tool, index: 0, id: `tool-${step}` }] } : { content: "Unexpected extra turn" }) },
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
    async function run(verificationCommand, calls) {
      sequence = calls;
      step = 0;
      return adapter.execute({
        runId: randomUUID(), agent: { id: randomUUID(), companyId: randomUUID(), name: "Fixture" },
        runtime: {}, context: { taskId: issueId }, authToken: "fixture-token",
        config: { profile: "compact", verificationCommand, cwd, model: model.id, timeoutSec: 20,
          env: { OPENROUTER_API_KEY: "fixture-key" } },
        onLog: async () => {},
      });
    }
    const getTask = call("paperclip_get_task", {});
    const done = call("paperclip_set_status", { status: "done", evidence: "Check passed." });
    const blocked = call("paperclip_set_status", { status: "blocked", evidence: "Check failed." });
    const bash = command => call("bash", { command });
    const ok = await run("printf 'ok\\n'", [getTask, bash("printf 'ok\\n'"), done]);
    assert.equal(ok.exitCode, 0, `${ok.errorMessage}; ${ok.resultJson?.stderr}; ${ok.resultJson?.stdout?.split("\n").filter(line => line.includes('"type":"tool_execution_end"')).join("\n")}`);
    assert.equal(step, 3);
    assert.deepEqual(writes, [{ status: "done", comment: "Check passed." }]);
    assert.match(JSON.stringify(requests[0]), /"cache_control":/);
    const failed = await run("exit 7", [getTask, bash("exit 7"), done, blocked]);
    assert.equal(failed.exitCode, 0, failed.errorMessage);
    assert.deepEqual(writes.map(write => write.status), ["done", "blocked"]);
    const repeat = call("ls", { path: "." });
    const loop = await run("exit 7", [repeat, repeat, repeat]);
    assert.equal(loop.errorCode, "openrouter_tool_loop", loop.errorMessage);
    assert.equal(step, 3);
    assert.equal(writes.length, 2);
  } finally {
    if (oldUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldUrl;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(cwd, { force: true, recursive: true });
  }
});
