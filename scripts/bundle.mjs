// Bundles the CLI (with the MCP SDK) into one dependency-free file inside the skill folder,
// so installing the skill never needs `npm install`.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "skills/agent-computer/scripts/agent-computer.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Some bundled CommonJS deps call require(); give them one in ESM.
  banner: { js: 'import { createRequire as __acRequire } from "node:module"; const require = __acRequire(import.meta.url);' },
});
console.log("bundled skills/agent-computer/scripts/agent-computer.mjs");
