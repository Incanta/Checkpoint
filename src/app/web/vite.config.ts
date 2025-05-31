import dns from "dns";

import type { UserConfig } from "vite";
import { defineConfig } from "vite";

import redwood from "@redwoodjs/vite";

// So that Vite will load on localhost instead of `127.0.0.1`.
// See: https://vitejs.dev/config/server-options.html#server-host.
dns.setDefaultResultOrder("verbatim");

const viteConfig: UserConfig = {
  plugins: [redwood()],
  server: {
    allowedHosts: ["redwood", "web"],
    watch: {
      usePolling: true,
    },
  },
};

export default defineConfig(viteConfig);
