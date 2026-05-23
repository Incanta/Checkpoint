/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  output: "standalone",
  serverExternalPackages: ["@incanta/config", "@checkpointvcs/longtail-addon"],
  outputFileTracingIncludes: {
    "/**": [
      "../../node_modules/@incanta/config/lib/config-env.js",
      "../../node_modules/@checkpointvcs/longtail-addon/**/*",
    ],
  },
  logging: {
    incomingRequests: false,
  },
  // Prevent Node.js-only modules from causing Turbopack compilation errors
  // in the browser/client bundle (transitively pulled in via type-only imports).
  turbopack: {
    resolveAlias: {
      net: { browser: "./src/stubs/empty-module.js" },
      tls: { browser: "./src/stubs/empty-module.js" },
      fs: { browser: "./src/stubs/empty-module.js" },
      worker_threads: { browser: "./src/stubs/empty-module.js" },
      child_process: { browser: "./src/stubs/empty-module.js" },
      "node:fs": { browser: "./src/stubs/empty-module.js" },
      "node:net": { browser: "./src/stubs/empty-module.js" },
      "node:tls": { browser: "./src/stubs/empty-module.js" },
      "node:worker_threads": { browser: "./src/stubs/empty-module.js" },
      "node:child_process": { browser: "./src/stubs/empty-module.js" },
    },
  },
  // Prevent Node.js-only modules from causing webpack compilation errors
  // in the browser/client bundle (for non-Turbopack builds).
  webpack: (webpackConfig, { isServer }) => {
    if (!isServer) {
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        net: false,
        tls: false,
        fs: false,
        worker_threads: false,
        child_process: false,
        "node:fs": false,
        "node:net": false,
        "node:tls": false,
        "node:worker_threads": false,
        "node:child_process": false,
      };
    }
    return webpackConfig;
  },
};

export default config;
