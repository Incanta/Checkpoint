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
};

export default config;
