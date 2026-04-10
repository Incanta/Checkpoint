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
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "frame-src 'self' https://checkout.stripe.com https://js.stripe.com https://hooks.stripe.com",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default config;
