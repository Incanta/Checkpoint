import { build, context } from "esbuild";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Source of truth for versions is versions.json (client_version is the
// user-facing client/daemon semver).
const version = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../versions.json"), "utf-8"),
).client_version;

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.resolve(__dirname, "src/extension.ts")],
  bundle: true,
  platform: "node",
  // VS Code's extension host loads extensions as CommonJS.
  format: "cjs",
  target: "node20",
  outfile: path.resolve(__dirname, "dist/extension.js"),
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  define: {
    "process.env.CHECKPOINT_VERSION": JSON.stringify(version),
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(options);
  console.log(`Checkpoint VS Code extension bundled successfully (v${version})`);
}
