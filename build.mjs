// Bundles the OpenCode + Claude entries into single ESM files. The banner
// restores `require` so bundled CommonJS deps (e.g. proper-lockfile) can load
// Node builtins under the ESM output format.
import { build } from "esbuild";

const banner = {
  js: "import { createRequire as __coreAuthCreateRequire } from 'module'; const require = __coreAuthCreateRequire(import.meta.url);",
};

const common = { bundle: true, platform: "node", format: "esm", banner, logLevel: "info" };

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["src/handler.ts"], outfile: "dist/handler.js" });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" });
