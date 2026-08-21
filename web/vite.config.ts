import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev-server proxy mirrors the production nginx topology (see
// docker-compose.yml + § "Local topology and networking" in
// design/2026-08-20-agent-wolf.md): the browser talks to /api and /mcp on
// this origin, never straight to wolf-api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${process.env.WOLF_API_PORT ?? 8100}`, changeOrigin: true },
      "/mcp": { target: `http://localhost:${process.env.WOLF_API_PORT ?? 8100}`, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
