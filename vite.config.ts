import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [preact()],
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "es2022" },
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8080", ws: true },
      "/api": "http://localhost:8080",
    },
  },
});
