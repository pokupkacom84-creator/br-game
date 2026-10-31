import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills({ globals: { Buffer: true, process: true, global: true } })],
  build: {
    lib: { entry: "bridge.js", name: "TGBridge", formats: ["iife"], fileName: () => "tg-bridge.js" },
    outDir: "dist",
    minify: true,
  },
});
