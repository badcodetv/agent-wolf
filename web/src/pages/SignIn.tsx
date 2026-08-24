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
 * Neither door skips the allowlist: Orange verifying a credential is
 * necessary, never sufficient (`api/src/routes/auth.ts`). A verified identity
 * that is not on `WOLF_ALLOWED_EMAILS` is a **403**, distinct from the 401 a
 * request with no cookie gets, and both messages are surfaced verbatim.
 *
 * The GIS script is fetched from Google, which is the one remote fetch in this
 * application. It is loaded LAZILY and only when a client id was built in — a
 * product that argues about remote fetches for a living should not make one it
 * cannot use.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Severity from "../components/trust/Severity.js";
import { ApiError, devLogin, signInWithGoogle } from "../api/client.js";
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
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

  async function submitDevLogin(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const user = await devLogin(email, password);
      onSignedIn(user.email);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ maxWidth: 420, mx: "auto", mt: 8, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography sx={{ fontSize: 20, fontWeight: 600 }}>Agent Wolf</Typography>

      {clientId === undefined ? (
        <Typography data-testid="no-google-client-id" sx={{ fontSize: 13, color: "text.secondary" }}>
          This build carries no VITE_GOOGLE_CLIENT_ID, so Google sign-in is not available here.
        </Typography>
      ) : (
        <div data-testid="google-button" ref={buttonHost} />
      )}

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

      {failure !== null ? <Severity level="degraded" cause={failure} /> : null}
    </Box>
  );
}
