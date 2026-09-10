/**
 * Sign-in.
 *
 * Two doors, and they are not equivalent:
 *
 *  - **Google Identity Services**, the real one. `VITE_GOOGLE_CLIENT_ID` is a
 *    BUILD arg (see `env.ts`), so a stack built without it renders no Google
 *    button at all and says why — rather than a button that cannot work.
 *  - **`POST /api/auth/dev-login`**, mounted on the API only when
 *    `WOLF_TEST_LOGIN` is set, and refused outright by `loadConfig` when
 *    `NODE_ENV=production`. It exists because Playwright cannot obtain a real
 *    Google ID token offline. A 404 from it means "this stack has no offline
 *    login", not "wrong password", and Express answers that 404 with an HTML
 *    body rather than the taxonomy shape — which `api/client.ts` handles.
 *
 * 🔴 **The second door is COMMENTED OUT of this page as of 2026-09-08, by
 * owner decision: Google is the only way in that a human is offered.** The
 * form was a password box on the front door of a product whose whole claim is
 * that it does not trust things, and it advertised the existence of an offline
 * bypass to anyone who loaded the page.
 *
 * Nothing was deleted. Every commented region below is tagged
 * `DEV-LOGIN-UI` — uncomment all of them together and the form is back. The
 * API route, `devLogin()` in `api/client.ts`, and their tests are all
 * untouched and still green, so the *capability* is intact; only the UI
 * affordance is gone. **Playwright never used this form** — `e2e/helpers/x1.ts`
 * and `e2e/layout-probe.mjs` both POST straight to the route — so hiding it
 * costs the test rig nothing. That is why this is safe.
 *
 * Neither door skips the allowlist: Bob verifying a credential is
 * necessary, never sufficient (`api/src/routes/auth.ts`). A verified identity
 * that is not on `WOLF_ALLOWED_EMAILS` is a **403**, distinct from the 401 a
 * request with no cookie gets, and both messages are surfaced verbatim.
 *
 * The GIS script is fetched from Google, which is the one remote fetch in this
 * application. It is loaded LAZILY and only when a client id was built in — a
 * product that argues about remote fetches for a living should not make one it
 * cannot use.
 */

import { useEffect, useRef, useState } from "react";
// DEV-LOGIN-UI: import { type FormEvent } from "react";
import Box from "@mui/material/Box";
// DEV-LOGIN-UI: import Button from "@mui/material/Button";
// DEV-LOGIN-UI: import Divider from "@mui/material/Divider";
// DEV-LOGIN-UI: import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Severity from "../components/trust/Severity.js";
import { ApiError, signInWithGoogle } from "../api/client.js";
// DEV-LOGIN-UI: `devLogin` is still exported and still tested — just not called here.
// DEV-LOGIN-UI: import { devLogin } from "../api/client.js";
import { googleClientId } from "../env.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (r: { credential: string }) => void }): void;
      renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

function gis(): GoogleIdentityServices | undefined {
  return (window as unknown as { google?: GoogleIdentityServices }).google;
}

/** Loads the GIS script once per document. Resolves false if it cannot load. */
function loadGis(): Promise<boolean> {
  if (gis() !== undefined) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(gis() !== undefined), { once: true });
    script.addEventListener("error", () => resolve(false), { once: true });
    if (existing === null) {
      script.src = GIS_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export interface SignInProps {
  onSignedIn: (email: string) => void;
}

export default function SignIn({ onSignedIn }: SignInProps) {
  const clientId = googleClientId();
  const buttonHost = useRef<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // DEV-LOGIN-UI: const [busy, setBusy] = useState(false);
  // DEV-LOGIN-UI: const [email, setEmail] = useState("");
  // DEV-LOGIN-UI: const [password, setPassword] = useState("");

  useEffect(() => {
    if (clientId === undefined) return;
    let mounted = true;
    void loadGis().then((ready) => {
      const host = buttonHost.current;
      const api = gis();
      if (!mounted || !ready || api === undefined || host === null) return;
      api.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          void (async () => {
            try {
              const user = await signInWithGoogle(credential);
              onSignedIn(user.email);
            } catch (err) {
              setFailure(err instanceof ApiError ? err.message : "sign-in failed");
            }
          })();
        },
      });
      api.accounts.id.renderButton(host, { theme: "outline", size: "large" });
    });
    return () => {
      mounted = false;
    };
  }, [clientId, onSignedIn]);

  // DEV-LOGIN-UI ─────────────────────────────────────────────────────────
  // async function submitDevLogin(event: FormEvent): Promise<void> {
  //   event.preventDefault();
  //   setBusy(true);
  //   setFailure(null);
  //   try {
  //     const user = await devLogin(email, password);
  //     onSignedIn(user.email);
  //   } catch (err) {
  //     setFailure(err instanceof ApiError ? err.message : "sign-in failed");
  //   } finally {
  //     setBusy(false);
  //   }
  // }
  // ───────────────────────────────────────────────────────────────────────

  // `sign-in` is the page's own handle. `App.test.tsx` used to assert the auth
  // gate by looking for `dev-submit`, which tied a test about the gate to a
  // control that is now hidden. It asserts on this instead.
  return (
    <Box
      data-testid="sign-in"
      sx={{ maxWidth: 420, mx: "auto", mt: 8, display: "flex", flexDirection: "column", gap: 2 }}
    >
      <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Agent Wolf</Typography>

      {clientId === undefined ? (
        <Typography data-testid="no-google-client-id" sx={{ fontSize: 13, color: "text.secondary" }}>
          This build carries no VITE_GOOGLE_CLIENT_ID, so Google sign-in is not available here.
        </Typography>
      ) : (
        <div data-testid="google-button" ref={buttonHost} />
      )}

      {/* DEV-LOGIN-UI ───────────────────────────────────────────────────
      <Divider sx={{ fontSize: 12, color: "text.secondary" }}>or</Divider>

      <Box component="form" onSubmit={(e) => void submitDevLogin(e)} sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          Test-stack sign-in. Available only where the API was started with WOLF_TEST_LOGIN.
        </Typography>
        <TextField
          data-testid="dev-email"
          label="Email"
          size="small"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          data-testid="dev-password"
          label="Password"
          type="password"
          size="small"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button data-testid="dev-submit" type="submit" size="small" variant="outlined" disabled={busy}>
          Sign in
        </Button>
      </Box>
      ─────────────────────────────────────────────────────────────────── */}

      {failure !== null ? <Severity level="degraded" cause={failure} /> : null}
    </Box>
  );
}
