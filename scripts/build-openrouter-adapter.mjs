import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  stdin: {
    contents: 'export { parsePiStdoutLine as parseStdoutLine } from "@paperclipai/adapter-pi-local/ui";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    sourcefile: "openrouter-ui-parser.mjs",
  },
  outfile: fileURLToPath(new URL("../adapters/openrouter/ui-parser.js", import.meta.url)),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
});
