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
    setupFiles: ["./src/setupTests.ts"],
    server: {
      deps: {
        // Load-bearing, not tidiness (W28 criterion; agent-bob R125).
        // @agentkit/chat-ui ships ESM that imports @mui/icons-material,
        // whose own ESM build does a *directory* import
        // (".../@mui/material/utils"). Vite externalises node_modules for
        // SSR-style transforms by default, so Node resolves that directory
        // import itself and throws:
        //
        //   Directory import '<repo>/node_modules/@mui/material/styles' is
        //   not supported resolving ES modules imported from
        //   <repo>/node_modules/@agentkit/chat-ui/dist/components/
        //   ChatHistoryDrawer.js
        //
        // (Verified by deleting the entry and running the suite. R125 and the
        // W28 ticket quote a different first offender — @mui/material/utils
        // from @mui/icons-material — because which directory import Node hits
        // first depends on module order; the class of failure is identical.)
        //
        // The error names MUI's build, not ours, which is exactly why it
        // reads as "the package is broken". Inlining both scopes makes Vite
        // transform them instead, and the directory import resolves.
        // src/agentkit-chat-ui.test.tsx renders a tier-2 component and
        // fails outright without this.
        inline: [/@mui/, /@agentkit/],
      },
    },
  },
});
