import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOpenRouterAdapter } from "./openrouter-adapter.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-openrouter-"));
  const home = join(root, "persistent");
  const userHome = join(root, "user");
  const packageDir = join(root, "adapter");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(home);
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "paperclip-openrouter-adapter", version: "1.0.0" }));
  writeFileSync(join(packageDir, "ui-parser.js"), "export {};");
  try {
    run({ home, userHome, packageDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("registration persists across restarts without replacing adapters or enable settings", () => fixture(options => {
  const store = join(options.home, "adapter-plugins.json");
  const other = { type: "example", packageName: "another-adapter" };
  writeFileSync(store, JSON.stringify([other]));
  registerOpenRouterAdapter(options);
  let records = JSON.parse(readFileSync(store));
  assert.deepEqual(records[0], other);
  assert.equal(records[1].type, "openrouter");
  records[1].disabled = true;
  writeFileSync(store, JSON.stringify(records));
  registerOpenRouterAdapter(options);
  const once = readFileSync(store, "utf8");
  registerOpenRouterAdapter(options);
  assert.equal(readFileSync(store, "utf8"), once);
  records = JSON.parse(once);
  assert.equal(records.length, 2);
  assert.equal(records[1].disabled, true);
  const sessions = join(options.userHome, ".pi", "paperclips");
  assert.equal(lstatSync(sessions).isSymbolicLink(), true);
  assert.equal(realpathSync(sessions), realpathSync(join(options.home, "openrouter", "sessions")));
}));

test("registration refuses corrupt stores and foreign adapter collisions", () => fixture(options => {
  const store = join(options.home, "adapter-plugins.json");
  writeFileSync(store, "{}");
  assert.throws(() => registerOpenRouterAdapter(options), /not an array/);
  writeFileSync(store, JSON.stringify([{ type: "openrouter", packageName: "someone-elses-adapter" }]));
  assert.throws(() => registerOpenRouterAdapter(options), /different OpenRouter adapter/);
  assert.equal(existsSync(join(options.userHome, ".pi")), false);
}));

test("existing Pi sessions are never overwritten", () => fixture(options => {
  const sessions = join(options.userHome, ".pi", "paperclips");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "existing-session"), "keep");
  assert.throws(() => registerOpenRouterAdapter(options), /already exists outside/);
  assert.equal(readFileSync(join(sessions, "existing-session"), "utf8"), "keep");
  assert.equal(existsSync(join(options.home, "adapter-plugins.json")), false);
}));
