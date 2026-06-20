import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  // Relative base so the packaged app's index.html references assets as
  // "./assets/..." which resolve correctly under file:// (an absolute "/"
  // base resolves to the drive root and is blocked as a local resource).
  base: "./",
  build: {
    // The main process (src/main/main.ts) loads dist/renderer/index.html, so
    // the renderer must build there. The electron plugin emits main/preload to
    // dist/main separately.
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: "src/main/main.ts",
        vite: {
          build: {
            outDir: "dist/main",
            sourcemap: true,
          },
        },
        onstart: (onstartArgs) => {
          onstartArgs.startup([
            ".",
            "--no-sandbox",
            "--remote-debugging-port=19229",
          ]);
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, "src/main/preload.ts"),
        vite: {
          build: {
            outDir: "dist/main",
          },
        },
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer:
        process.env.NODE_ENV === "test"
          ? // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
            undefined
          : {},
    }),
  ],
});
