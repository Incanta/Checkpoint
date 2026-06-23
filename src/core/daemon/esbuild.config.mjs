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
        // Redirect imports of @checkpointvcs/longtail-addon to a runtime
        // resolver that finds the .node binary relative to the SEA executable.
        build.onResolve(
          { filter: /^@checkpointvcs\/longtail-addon/ },
          (args) => {
            return {
              path: args.path,
              namespace: "longtail-addon",
            };
          },
        );

        build.onLoad(
          { filter: /.*/, namespace: "longtail-addon" },
          (args) => {
            // At runtime, process.execPath points to the daemon runtime
            // (checkpoint-daemon). The .node addon will be in a lib/
            // subdirectory next to it (or in the same directory).
            const isSubpath = args.path !== "@checkpointvcs/longtail-addon";
            if (isSubpath) {
              // Handle sub-path imports like @checkpointvcs/longtail-addon/types
              return {
                contents: `
                  // Sub-path import stub: ${args.path}
                  module.exports = {};
                `,
                loader: "js",
              };
            }

            return {
              contents: `
                const path = require("path");
                const os = require("os");

                function getAddonPath() {
                  const execDir = path.dirname(process.execPath);
                  const platform = process.platform;
                  const arch = process.arch;
                  const addonName = "longtail_addon.node";

                  // Search order:
                  // 1. lib/ subdirectory (installed layout)
                  // 2. Same directory as executable
                  // 3. prebuilds/{platform}-{arch}/ (development layout)
                  const candidates = [
                    path.join(execDir, "lib", addonName),
                    path.join(execDir, addonName),
                    path.join(execDir, "prebuilds", platform + "-" + arch, addonName),
                  ];

                  for (const candidate of candidates) {
                    try {
                      require("fs").accessSync(candidate);
                      return candidate;
                    } catch {}
                  }

                  throw new Error(
                    "Could not find longtail_addon.node. Searched: " +
                    candidates.join(", ")
                  );
                }

                const addonPath = getAddonPath();
                const addon = __require(addonPath);
                module.exports = addon;
              `,
              loader: "js",
            };
          },
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
