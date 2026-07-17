import { build } from "esbuild";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Source of truth for versions is versions.json (client_version is the
// user-facing desktop/daemon semver).
const version = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../versions.json"), "utf-8"),
).client_version;

// The published @checkpointvcs/longtail-addon npm package resolves its native
// binary relative to its own __dirname, which does not exist in the bundled
// portable-daemon layout. Bundle the local wrapper source instead: esbuild
// transpiles the TypeScript directly, and its loadNativeAddon() locates the
// .node binary relative to process.execPath (see src/longtail/addon/lib).
const longtailWrapperSource = path.resolve(
  __dirname,
  "../../longtail/addon/lib/index.ts",
);

await build({
  entryPoints: [path.resolve(__dirname, "src/bin.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.resolve(__dirname, "daemon-bundle.cjs"),
  sourcemap: false,
  minify: false,
  // Native .node addons cannot be bundled into a single JS file.
  // They must be shipped alongside the daemon runtime and loaded at runtime.
  // better-sqlite3 is handled by the plugin below (it is loaded via
  // createRequire from disk next to the runtime, not from the JS bundle).
  external: ["*.node"],
  banner: {
    js: [
      `// Checkpoint Daemon v${version} (esbuild bundle, run by portable Node.js)`,
      `const __CHECKPOINT_VERSION__ = ${JSON.stringify(version)};`,
      // Make require() available in the CJS bundle for native addon loading
      `const { createRequire } = require("module");`,
      `const __require = createRequire(__filename);`,
    ].join("\n"),
  },
  define: {
    "process.env.CHECKPOINT_VERSION": JSON.stringify(version),
    // CJS output replaces `import.meta` with `{}`, so `import.meta.url` becomes
    // undefined and breaks deps like `open` that call fileURLToPath on it at
    // load time. Map it to the injected `importMetaUrl` binding instead.
    "import.meta.url": "importMetaUrl",
  },
  inject: [path.resolve(__dirname, "import-meta-url-shim.mjs")],
  plugins: [
    {
      name: "native-addon-resolver",
      setup(build) {
        // Bundle the LOCAL longtail wrapper source instead of the published
        // npm dist. The wrapper is a JS layer over the native addon that also
        // adds JS-only helpers (GetLogLevel, pollHandle, pollReadFileHandle).
        // The previous approach replaced the whole module with just the native
        // .node binary, which dropped those helpers and caused runtime
        // "GetLogLevel is not a function" errors. Using the local source also
        // brings in the execPath-relative loadNativeAddon() that finds the
        // .node binary in the portable-daemon layout; the native require stays
        // dynamic thanks to external: ["*.node"].
        build.onResolve(
          { filter: /^@checkpointvcs\/longtail-addon(\/.*)?$/ },
          (args) => {
            if (args.path === "@checkpointvcs/longtail-addon") {
              return { path: longtailWrapperSource };
            }
            // Sub-path imports (e.g. /types) are type-only at runtime.
            return { path: args.path, namespace: "longtail-addon-stub" };
          },
        );

        build.onLoad(
          { filter: /.*/, namespace: "longtail-addon-stub" },
          () => ({ contents: "module.exports = {};", loader: "js" }),
        );

        // better-sqlite3 is a native module that ships in node_modules/ next to
        // the daemon runtime. Load it via createRequire rooted at the runtime's
        // directory (process.execPath) so it resolves regardless of cwd.
        build.onResolve({ filter: /^better-sqlite3$/ }, (args) => ({
          path: args.path,
          namespace: "sea-external-module",
        }));

        build.onLoad(
          { filter: /.*/, namespace: "sea-external-module" },
          (args) => ({
            contents: `
              const { createRequire } = require("module");
              const seaRequire = createRequire(process.execPath);
              module.exports = seaRequire(${JSON.stringify(args.path)});
            `,
            loader: "js",
          }),
        );
      },
    },
  ],
});

console.log(`Daemon bundled successfully (v${version})`);
