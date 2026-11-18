export const COMPACT_PROMPT = `Work only on the current Paperclip issue. Call paperclip_get_task first. Do the work with the available tools, then run the operator's verification command exactly as provided. Call paperclip_set_status with done and a short evidence note only if verification passed. Otherwise use blocked with a concrete reason, or leave the issue open if unsure. The status tool posts your note; do not post it twice. Stop after a successful status update. Never repeat an unchanged action expecting a different result.`;

export function createIssueTools({ env, issueId, verificationCommand, state, persist = () => {}, fetchImpl = fetch }) {
  const { PAPERCLIP_API_URL: base, PAPERCLIP_API_KEY: token, PAPERCLIP_RUN_ID: runId } = env;
  if (!base || !token || !runId || !/^[0-9a-f-]{36}$/i.test(issueId ?? "")) return null;
  const url = new URL(`${base.replace(/\/+$/, "").replace(/\/api$/, "")}/api/issues/${issueId}`);
  async function request(method, suffix = "", body) {
    const response = await fetchImpl(`${url}${suffix}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Paperclip-Run-Id": runId,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Paperclip ${method} failed (HTTP ${response.status}).`);
    return response.json();
  }
  function note(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 2000) {
      throw new Error("Provide a nonempty note of at most 2,000 characters.");
    }
    return value.trim();
  }
  return {
    async getTask() {
      const { identifier, title, description, status } = await request("GET");
      return { identifier, title, description, status, verificationCommand: verificationCommand || null };
    },
    async comment({ body }) {
      const text = note(body);
      if (state.wroteComment || state.terminal) throw new Error("An update was already submitted.");
      state.wroteComment = true;
      persist();
      await request("POST", "/comments", { body: text });
      return "Comment posted.";
    },
    async setStatus({ status, evidence }) {
      const text = note(evidence);
      if (state.terminal || state.statusAttempted) throw new Error("A status update was already submitted.");
      if (status !== "done" && status !== "blocked") throw new Error("Use done or blocked.");
      if (status === "done" && (!verificationCommand || !state.verified)) {
        throw new Error("Cannot mark done: the operator's exact verification command must pass after the last change.");
      }
      state.statusAttempted = true;
      persist();
      const updated = await request("PATCH", "", { status, comment: text });
      if (updated.status !== status) throw new Error("Paperclip did not confirm the requested issue status.");
      state.terminal = status;
      return `Issue marked ${status}. Stop now.`;
    },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export function createGuard({ maxToolCalls, maxRunInputTokens, verificationCommand }, state = {}) {
  let calls = 0;
  let inputTokens = 0;
  const repeats = new Map();
  const pendingWork = new Map();
  return {
    beforeTool({ toolName, toolCallId, input }) {
      if (state.terminal || state.stop) return { block: true, reason: "Run is finished." };
      const signature = JSON.stringify([toolName, stable(input)]);
      const count = (repeats.get(signature) ?? 0) + 1;
      repeats.set(signature, count);
      if (++calls > maxToolCalls || count >= 3) {
        state.stop = count >= 3 ? "openrouter_tool_loop" : "openrouter_tool_budget";
        return { block: true, reason: "Run stopped: repeated tool call or tool budget exceeded." };
      }
      if (toolName === "bash" || toolName === "edit" || toolName === "write") {
        state.workAttempted = true;
        state.verified = false;
        for (const id of pendingWork.keys()) pendingWork.set(id, false);
        pendingWork.set(toolCallId, pendingWork.size === 0 && Boolean(verificationCommand) &&
          toolName === "bash" && input.command === verificationCommand);
      }
    },
    afterTool({ toolCallId, isError }) {
      if (!pendingWork.has(toolCallId)) return;
      const check = pendingWork.get(toolCallId);
      pendingWork.delete(toolCallId);
      state.verified = check && !isError && pendingWork.size === 0;
    },
    afterMessage(message) {
      if (message.role !== "assistant" || !message.usage) return;
      const { input = 0, cacheRead = 0, cacheWrite = 0 } = message.usage;
      inputTokens += input + cacheRead + cacheWrite;
      if (inputTokens >= maxRunInputTokens) state.stop ||= "openrouter_input_budget";
    },
  };
}

export function routeRequest(payload, fallbackModels) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  return {
    ...payload,
    provider: { ...payload.provider, require_parameters: true },
    ...(fallbackModels.length ? { models: [payload.model, ...fallbackModels] } : {}),
  };
}
