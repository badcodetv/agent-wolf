/**
 * The app shell: **ONE route table**, one sign-in gate, one header.
 *
 * ```
 * /                       Board — the attention queue
 * /new                    New hypothesis (title only) → interview
 * /hypotheses/:id         Detail — two columns (W14 fills the left column)
 * /hypotheses/:id/golive  Go live review — approve the candidate report (W24)
 * /archive                Archive — terminal states, with restated_from lineage
 * ```
 *
 * W24 added `/hypotheses/:id/golive` to the table below. There must not be a
 * second router or a second table: React Router 7 resolves the most specific
 * match, and two tables would race to render two pages for one URL.
 *
 * ## The sign-in gate
 *
 * `GET /api/auth/me` is the single question asked — added by W8b precisely so
 * the UI does not have to infer the signed-in state from a 401 on the board.
 * A 401 renders `SignIn`; anything else renders the app. Sign-out is
 * `POST /api/auth/logout` (204 always, even with no cookie) and it is a POST
 * on purpose: a GET logout is triggerable by a prefetch, an `<img>` tag or a
 * link inside a report panel, and this product renders model-authored HTML in
 * an iframe.
 */

import { useCallback, useEffect, useState } from "react";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Skeleton from "@mui/material/Skeleton";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { BrowserRouter, Link as RouterLink, Route, Routes } from "react-router";
import Link from "@mui/material/Link";
import HypothesisList from "./pages/HypothesisList.js";
import NewHypothesis from "./pages/NewHypothesis.js";
import Archive from "./pages/Archive.js";
import HypothesisDetail from "./pages/HypothesisDetail.js";
import GoLiveReview from "./pages/GoLiveReview.js";
import SignIn from "./pages/SignIn.js";
import { ApiError, fetchMe, logout } from "./api/client.js";

/** The one route table. Every page in the app is registered HERE. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HypothesisList />} />
      <Route path="/new" element={<NewHypothesis />} />
      <Route path="/archive" element={<Archive />} />
      <Route path="/hypotheses/:id" element={<HypothesisDetail />} />
      {/* More specific than `/hypotheses/:id`, and React Router 7 resolves the
          more specific match — so the detail page does not swallow it. */}
      <Route path="/hypotheses/:id/golive" element={<GoLiveReview />} />
      <Route
        path="*"
        element={
          <Typography data-testid="not-found" sx={{ fontSize: 13 }}>
            No such page.
          </Typography>
        }
      />
    </Routes>
  );
}

export interface AppShellProps {
  email: string;
  onSignOut: () => void;
}

export function AppShell({ email, onSignOut }: AppShellProps) {
  return (
    // 🔴 A FIXED-HEIGHT SHELL, not a `minHeight` that lets the document grow.
    //
    // The document used to scroll, and the detail page's rail is a full-height
    // column inside it — so the two fought. The rail sat below a ~48px toolbar
    // with `height: 100vh`, which put its last 48px (the message input) below
    // the fold; scrolling to reach it slid the sticky rail up over where the
    // header had been and clipped the rail's own heading. Three scrollbars —
    // document, rail, iframe — and none of them where the reader was looking.
    //
    // Now the shell is exactly the viewport, the toolbar is a flex item, and
    // the region below it is the only scroll container the app has. `100dvh`
    // rather than `100vh` because mobile browsers' `vh` includes retracting
    // chrome, which is how a "full height" layout ends up 60px too tall.
    <Box
      sx={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: "background.default",
      }}
    >
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Link component={RouterLink} to="/" underline="none" sx={{ fontWeight: 700, fontSize: 14 }}>
            Agent Wolf
          </Link>
          <Link component={RouterLink} to="/archive" underline="hover" sx={{ fontSize: 13 }}>
            Archive
          </Link>
          <Box sx={{ flex: 1 }} />
          <Typography data-testid="signed-in-email" variant="mono" sx={{ fontSize: 12, color: "text.secondary" }}>
            {email}
          </Typography>
          <Button data-testid="sign-out" size="small" onClick={onSignOut}>
            Sign out
          </Button>
        </Toolbar>
      </AppBar>
      {/* `maxWidth: false` — the detail page is two columns and the rail needs
          the width; a centred 1200px column would squeeze it to nothing.

          `flex: 1; minHeight: 0` makes this the app's single scroll region:
          `minHeight: 0` is the load-bearing half, because a flex item's
          default `min-height: auto` refuses to shrink below its content and
          the overflow would escape to the document again. A page that manages
          its own scrolling (the detail page) sets `height: 100%` and overflows
          nothing, so no scrollbar appears here for it. */}
      <Container
        maxWidth={false}
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", py: 2 }}
      >
        <AppRoutes />
      </Container>
    </Box>
  );
}

/** The gate. Exported so a test can drive it without a `BrowserRouter`. */
export function AuthenticatedApp() {
  const [email, setEmail] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    try {
      const user = await fetchMe();
      setEmail(user.email);
    } catch (err) {
      // 401 is the ordinary "not signed in" answer, not a failure to report.
      // Any other error also lands here: with no usable identity there is
      // nothing to show but the sign-in page.
      if (!(err instanceof ApiError)) throw err;
      setEmail(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const signOut = useCallback(() => {
    void (async () => {
      try {
        await logout();
      } catch {
        // 204 always, even with no cookie — but if the request itself fails,
        // the local state still clears. A sign-out button that refuses to sign
        // out is worse than one that races the server.
      }
      setEmail(null);
    })();
  }, []);

  if (!checked) return <Skeleton data-testid="auth-checking" variant="rectangular" height={64} />;
  if (email === null) return <SignIn onSignedIn={(signedIn) => setEmail(signedIn)} />;
  return <AppShell email={email} onSignOut={signOut} />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthenticatedApp />
    </BrowserRouter>
  );
}
