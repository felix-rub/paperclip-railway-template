const MODELS_URL = "https://openrouter.ai/api/v1/models";

function pricePerMillion(value, name) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`OpenRouter returned invalid ${name} pricing for the selected model.`);
  }
  return parsed * 1_000_000;
}

export function toRuntimeModel(entry) {
  const contextWindow = entry.context_length;
  const maxTokens = entry.top_provider?.max_completion_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
      !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("OpenRouter did not report valid context/output limits for the selected model.");
  }
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: entry.supported_parameters.includes("reasoning") ||
      entry.supported_parameters.includes("reasoning_effort"),
    input: entry.architecture.input_modalities.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: pricePerMillion(entry.pricing?.prompt, "input"),
      output: pricePerMillion(entry.pricing?.completion, "output"),
      cacheRead: pricePerMillion(entry.pricing?.input_cache_read ?? entry.pricing?.prompt, "cache-read"),
      cacheWrite: pricePerMillion(entry.pricing?.input_cache_write ?? entry.pricing?.prompt, "cache-write"),
    },
    contextWindow,
    maxTokens: Math.min(maxTokens, contextWindow),
  };
}

export function createCatalog(fetchImpl = fetch) {
  let cached;
  let pending;
  async function entries(refresh = false) {
    if (!refresh && cached && cached.until > Date.now()) return cached.models;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(MODELS_URL, {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`OpenRouter model discovery failed (HTTP ${response.status}).`);
      const body = await response.json();
      if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
      const models = body.data.filter(entry =>
        typeof entry?.id === "string" &&
        entry.id.includes("/") &&
        Array.isArray(entry.supported_parameters) &&
        entry.supported_parameters.includes("tools") &&
        entry.architecture?.input_modalities?.includes("text") &&
        entry.architecture?.output_modalities?.includes("text"));
      if (models.length === 0) throw new Error("OpenRouter returned no tool-capable text models.");
      cached = { until: Date.now() + 60_000, models };
      return models;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  return {
    async list(refresh = false) {
      return (await entries(refresh)).map(entry => ({
        id: entry.id,
        label: entry.name || entry.id,
      })).sort((a, b) => a.label.localeCompare(b.label));
    },
    async resolve(model) {
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("Choose an OpenRouter model before running the agent.");
      }
      const requested = model.trim();
      const find = models => models.find(entry => entry.id === requested) ??
        models.find(entry => `openrouter/${entry.id}` === requested);
      let entry = find(await entries());
      if (!entry) entry = find(await entries(true));
      if (!entry) throw new Error(`OpenRouter model "${requested}" is unavailable or does not support tools and text output.`);
      return toRuntimeModel(entry);
    },
  };
}
