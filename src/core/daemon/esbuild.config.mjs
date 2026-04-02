import { build } from "esbuild";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const version = readFileSync(
  path.resolve(__dirname, "../../../VERSION"),
  "utf-8",
).trim();

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
  // They must be shipped alongside the SEA binary and loaded at runtime.
  external: ["*.node"],
  banner: {
    js: [
      `// Checkpoint Daemon v${version} — Single Executable Application bundle`,
      `const __CHECKPOINT_VERSION__ = ${JSON.stringify(version)};`,
      // Make require() available in the CJS bundle for native addon loading
      `const { createRequire } = require("module");`,
      `const __require = createRequire(__filename);`,
    ].join("\n"),
  },
  define: {
    "process.env.CHECKPOINT_VERSION": JSON.stringify(version),
  },
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
            // At runtime in the SEA binary, process.execPath points to the
            // daemon binary. The .node addon will be in a lib/ subdirectory
            // next to it (or in the same directory).
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
      },
    },
  ],
});

console.log(`Daemon bundled successfully (v${version})`);
