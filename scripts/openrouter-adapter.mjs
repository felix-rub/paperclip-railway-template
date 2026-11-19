import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repairShadowedPiBinary({
  dirs = [],
  bundledPiPath = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url)),
  platform = process.platform,
  linkFn = symlinkSync,
} = {}) {
  if (platform === "win32" || !existsSync(bundledPiPath)) return 0;
  const targetReal = realpathSync(bundledPiPath);
  let repaired = 0;
  for (const baseDir of new Set(dirs.filter(Boolean).map(dir => resolve(dir)))) {
    const localBinPi = join(baseDir, ".local", "bin", "pi");
    const stat = lstatSync(localBinPi, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) continue;
    let currentReal = null;
    try {
      currentReal = realpathSync(localBinPi);
    } catch {
      currentReal = null;
    }
    if (currentReal === targetReal) continue;
    const tmpPi = `${localBinPi}.tmp-${process.pid}`;
    rmSync(tmpPi, { force: true });
    linkFn(targetReal, tmpPi);
    renameSync(tmpPi, localBinPi);
    repaired += 1;
  }
  return repaired;
}

export function registerOpenRouterAdapter({
  home = process.env.PAPERCLIP_HOME || "/paperclip",
  userHome = homedir(),
  packageDir = fileURLToPath(new URL("../adapters/openrouter", import.meta.url)),
  bundledPiPath = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url)),
} = {}) {
  if (!existsSync(join(packageDir, "ui-parser.js"))) {
    throw new Error("OpenRouter adapter UI parser is missing. Run npm run build before starting Paperclip.");
  }
  const storePath = join(home, "adapter-plugins.json");
  const records = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : [];
  if (!Array.isArray(records)) throw new Error("Paperclip adapter registration store is not an array.");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const current = records.find(record => record.type === "openrouter");
  if (current && current.packageName !== manifest.name) {
    throw new Error("A different OpenRouter adapter is already registered; refusing to replace it.");
  }

  const persistentSessions = join(home, "openrouter", "sessions");
  const sessionsLink = join(userHome, ".pi", "paperclips");
  mkdirSync(persistentSessions, { recursive: true });
  mkdirSync(dirname(sessionsLink), { recursive: true });
  if (existsSync(sessionsLink)) {
    if (realpathSync(sessionsLink) !== realpathSync(persistentSessions)) {
      throw new Error("Pi session directory already exists outside the persistent OpenRouter directory. Migrate it before enabling this adapter.");
    }
  } else {
    // lstat also catches a dangling symlink; never overwrite an operator's path.
    try {
      lstatSync(sessionsLink);
      throw new Error("Pi session directory contains a dangling link; repair it before enabling this adapter.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    symlinkSync(resolve(persistentSessions), sessionsLink, process.platform === "win32" ? "junction" : "dir");
  }
  repairShadowedPiBinary({ dirs: [home, userHome], bundledPiPath });

  const record = {
    ...current,
    packageName: manifest.name,
    localPath: resolve(packageDir),
    version: manifest.version,
    type: "openrouter",
    installedAt: current?.installedAt ?? new Date().toISOString(),
  };
  const next = current ? records.map(item => item === current ? record : item) : [...records, record];
  if (JSON.stringify(records) !== JSON.stringify(next)) {
    mkdirSync(home, { recursive: true });
    const tmp = `${storePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, storePath);
  }
}
