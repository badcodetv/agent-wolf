import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { App } from "./App.js";
import { useWolfTheme } from "./theme.js";

/**
 * The colour mode follows the OS and cannot be told otherwise — `useWolfTheme`
 * reads `prefers-color-scheme`, exactly as the Orange rail Wolf iframes does
 * (`examples/web/src/EmbedSession.tsx:77-80`). A toggle here would let the page
 * and the rail inside it disagree, with no way to reconcile them. See
 * design/2026-08-24-agent-wolf-ui.md § 2b principle 5 (agent-orange repo).
 *
 * It is a hook, so it needs a component: `createRoot(...).render()` cannot call
 * one directly.
 */
function Root() {
  const theme = useWolfTheme();
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
