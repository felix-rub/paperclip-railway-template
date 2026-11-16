import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function patchBundledZod(root = appRoot) {
  const source = join(root, "node_modules", "zod");
  const bundled = join(root, "node_modules", "@paperclipai", "server", "node_modules", "zod");
  if (!existsSync(bundled)) return;

  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).overrides.zod;
  const sourceVersion = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  const bundledVersion = JSON.parse(readFileSync(join(bundled, "package.json"), "utf8")).version;
  const sourceParts = /^4\.(\d+)\.(\d+)$/.exec(sourceVersion);
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(bundledVersion);
  if (sourceVersion !== expected || !sourceParts ||
      Number(sourceParts[1]) < 6 || (Number(sourceParts[1]) === 6 && Number(sourceParts[2]) < 6) ||
      !version || Number(version[1]) !== 4) {
    throw new Error(`Cannot safely update bundled Zod: root ${sourceVersion}, bundled ${bundledVersion}, expected ${expected}.`);
  }
  if (Number(version[2]) > 6 || (Number(version[2]) === 6 && Number(version[3]) >= 6)) return;

  rmSync(bundled, { recursive: true });
  cpSync(source, bundled, { recursive: true });
  console.log(`Updated Paperclip's bundled Zod from ${bundledVersion} to ${sourceVersion}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchBundledZod();
}
