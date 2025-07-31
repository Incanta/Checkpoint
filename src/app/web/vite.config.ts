import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      src: resolve(__dirname, "src"),
    },
  },
  server: {
    port: 8910,
    host: "0.0.0.0",
    watch: {
      usePolling: true,
    },
  },
  define: {
    // Define environment variables for the client
    'process.env.SUPERTOKENS_APP_NAME': JSON.stringify(process.env.SUPERTOKENS_APP_NAME),
    'process.env.SUPERTOKENS_WEBSITE_DOMAIN': JSON.stringify(process.env.SUPERTOKENS_WEBSITE_DOMAIN),
    'process.env.SUPERTOKENS_JWKS_URL': JSON.stringify(process.env.SUPERTOKENS_JWKS_URL),
    'process.env.SUPERTOKENS_CONNECTION_URI': JSON.stringify(process.env.SUPERTOKENS_CONNECTION_URI),
  },
});
