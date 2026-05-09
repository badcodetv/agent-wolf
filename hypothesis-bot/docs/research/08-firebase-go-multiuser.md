# Firebase Auth + Go Fiber v3 — Multi-User Brief for Hypothesis-Bot

> Goal: replace Platinum's custom username/password JWT auth with Firebase Authentication (Google OAuth) for hypothesis-bot, a 3–5-user trusted-team app. Keep Platinum's `requireAuthMiddleware` shape, server-struct dependency holding, and the *scoped HS256 JWT* used for sandbox → GoAPI callbacks. Swap only the verifier and add an allowlist.

---

## 1. Firebase Auth Go integration

### SDK and init

The official Go Admin SDK is `firebase.google.com/go/v4` (current major; v4 has been stable for several years and remains current as of 2026). It wraps `cloud.google.com/go/firestore` and `google.golang.org/api/option`. Auth lives in the `firebase.google.com/go/v4/auth` subpackage.

Service account: download `serviceAccountKey.json` from the Firebase console (Project Settings → Service Accounts → Generate new private key). In production, mount the file as a secret or expose its JSON via `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-sa.json`.

`goapi/pkg/auth/firebase.go`:

```go
package auth

import (
    "context"
    "fmt"

    firebase "firebase.google.com/go/v4"
    "firebase.google.com/go/v4/auth"
    "google.golang.org/api/option"
)

type Verifier struct {
    Client *auth.Client
}

func NewVerifier(ctx context.Context, credPath string) (*Verifier, error) {
    opt := option.WithCredentialsFile(credPath)
    app, err := firebase.NewApp(ctx, nil, opt)
    if err != nil {
        return nil, fmt.Errorf("firebase init: %w", err)
    }
    cli, err := app.Auth(ctx)
    if err != nil {
        return nil, fmt.Errorf("firebase auth client: %w", err)
    }
    return &Verifier{Client: cli}, nil
}

func (v *Verifier) Verify(ctx context.Context, idToken string) (*auth.Token, error) {
    // VerifyIDToken validates signature, audience (=projectID), issuer
    // (=https://securetoken.google.com/<projectID>), and expiry.
    return v.Client.VerifyIDToken(ctx, idToken)
}
```

### Verification cost

`auth.VerifyIDToken` is **purely local** after a one-time JWKS fetch: it pulls Google's public signing keys from `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`, caches them per the `Cache-Control` header (typically 1–6 hours), and verifies signatures locally. There is **no per-request network round-trip**. The cache is internal to the SDK; no extra work needed.

If you want revocation checks (e.g. "the user was disabled in Firebase 30 seconds ago"), call `VerifyIDTokenAndCheckRevoked` instead — *that* one does hit Google per request and is rarely worth it for a 3–5-user team.

### Fiber v3 middleware

`goapi/pkg/server/middleware_auth.go`:

```go
package server

import (
    "strings"

    "github.com/gofiber/fiber/v3"
    "github.com/rs/zerolog/log"
)

func (s *HypothesisAPIServer) requireAuthMiddleware(c fiber.Ctx) error {
    h := c.Get("Authorization")
    if !strings.HasPrefix(h, "Bearer ") {
        return fiber.NewError(fiber.StatusUnauthorized, "missing bearer token")
    }
    idToken := strings.TrimPrefix(h, "Bearer ")

    tok, err := s.Verifier.Verify(c.Context(), idToken)
    if err != nil {
        log.Debug().Err(err).Msg("firebase verify failed")
        return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
    }

    // Allowlist: either via custom claim or DB lookup.
    if v, ok := tok.Claims["team_member"].(bool); !ok || !v {
        return fiber.NewError(fiber.StatusForbidden, "not a team member")
    }

    user, err := s.Store.UpsertUserFromFirebase(c.Context(), tok)
    if err != nil {
        return fiber.NewError(fiber.StatusInternalServerError, "user upsert failed")
    }
    c.Locals("user", user)
    c.Locals("firebaseUID", tok.UID)
    return c.Next()
}
```

Token refresh on the backend: nothing to do. The Firebase JS SDK on the client transparently refreshes the ID token roughly every hour using the long-lived refresh token.

---

## 2. Frontend integration (React 18 + Vite)

### Packages

```
yarn add firebase
```

`frontend/src/firebase.ts`:

```ts
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, onIdTokenChanged } from "firebase/auth";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const watchToken = (cb: (t: string | null) => void) =>
  onIdTokenChanged(auth, async (u) => cb(u ? await u.getIdToken() : null));
```

### Where the token lives

**In-memory only.** Do not put the ID token in `localStorage` or `sessionStorage`. The Firebase JS SDK persists the *refresh* token in IndexedDB (its default), and we read the current ID token with `auth.currentUser.getIdToken()` on every API call. That call is cheap — the SDK returns the cached token if it's still valid (>5 minutes left) and refreshes silently otherwise.

This replaces Platinum's `AccountContext + sessionStorage` Bearer-token pattern.

### TanStack Query interceptor

```ts
// frontend/src/api/client.ts
import { auth } from "../firebase";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("not signed in");
  const token = await user.getIdToken(); // cheap; SDK refreshes if needed

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    // Force a fresh fetch in case the cached token was stale.
    const fresh = await user.getIdToken(true);
    return api(path, { ...init, headers: { ...(init.headers||{}), Authorization: `Bearer ${fresh}` } });
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

Wire this into TanStack Query as the `queryFn`/`mutationFn` body. No Axios interceptors, no token-refresh plumbing — Firebase JS handles it.

### Restricting to a list of allowed emails

Two viable approaches:

**(a) Server-side allowlist in Fiber middleware.** Simplest. Just a Postgres `allowed_emails` table (or even an env var `ALLOWED_EMAILS=a@x,b@y`) checked in `requireAuthMiddleware` before the upsert. Reject with 403 if not on the list.

**(b) Custom claim set by Cloud Function on first sign-in.** Cleaner — the token itself carries `team_member: true`. But it requires deploying a Cloud Function and a one-line Admin-SDK call to flip the claim per user.

**Recommendation for 3–5 users: do both, but trivially.** Set `team_member: true` *manually once per user* via a `goapi admin grant <email>` Cobra subcommand that calls `auth.SetCustomUserClaims`. No Cloud Function needed. The middleware checks the claim. The DB allowlist is the backup if you ever want to revoke without going through the Firebase console.

```go
// cmd/admin/grant.go (Cobra subcommand)
err := s.Verifier.Client.SetCustomUserClaims(ctx, uid, map[string]any{"team_member": true})
```

---

## 3. User model in Postgres

Schema (Platinum-style handwritten Go migration):

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid  TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  photo_url     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users(email);
```

`goapi/pkg/store/migrations/000001_users.go`:

```go
package migrations

import "database/sql"

func init() { Register(1, "users", up0001, nil) }

func up0001(tx *sql.Tx) error {
    _, err := tx.Exec(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        firebase_uid  TEXT UNIQUE NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        display_name  TEXT,
        photo_url     TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_users_email ON users(email);`)
    return err
}
```

### Upsert pattern on first login

```go
// goapi/pkg/store/users.go
func (s *Store) UpsertUserFromFirebase(ctx context.Context, tok *auth.Token) (*types.User, error) {
    email, _ := tok.Claims["email"].(string)
    name, _  := tok.Claims["name"].(string)
    pic, _   := tok.Claims["picture"].(string)

    var u types.User
    err := s.pg.QueryRow(ctx, `
      INSERT INTO users (firebase_uid, email, display_name, photo_url)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (firebase_uid) DO UPDATE
        SET email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            photo_url = EXCLUDED.photo_url,
            last_login_at = now()
      RETURNING id, firebase_uid, email, display_name, photo_url, created_at, last_login_at;`,
      tok.UID, email, name, pic,
    ).Scan(&u.ID, &u.FirebaseUID, &u.Email, &u.DisplayName, &u.PhotoURL, &u.CreatedAt, &u.LastLoginAt)
    return &u, err
}
```

`GET /api/v1/me` is a one-liner that returns `c.Locals("user")` as JSON.

---

## 4. Multi-user collaboration data model

`hypotheses` carries `owner_id UUID REFERENCES users(id)`. Sharing goes through a join table:

```sql
CREATE TYPE collab_role AS ENUM ('owner','editor','viewer');

CREATE TABLE hypothesis_collaborators (
  hypothesis_id UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role          collab_role NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hypothesis_id, user_id)
);
CREATE INDEX idx_collab_user ON hypothesis_collaborators(user_id);
```

The owner is a row in this table *as well as* `hypotheses.owner_id` — keeps queries uniform. On hypothesis create, insert both rows in the same transaction.

### Authorization helper

```go
// goapi/pkg/store/authz.go
func (s *Store) CheckHypothesisAccess(
    ctx context.Context, userID, hypothesisID uuid.UUID, minRole types.Role,
) (types.Role, error) {
    var role types.Role
    err := s.pg.QueryRow(ctx,
      `SELECT role FROM hypothesis_collaborators WHERE hypothesis_id=$1 AND user_id=$2`,
      hypothesisID, userID,
    ).Scan(&role)
    if err != nil { return "", ErrForbidden }
    if !role.Satisfies(minRole) { return role, ErrForbidden }
    return role, nil
}
```

`Role.Satisfies` orders `viewer < editor < owner`.

### Canonical handler

```go
func (s *HypothesisAPIServer) deleteHypothesis(c fiber.Ctx) error {
    user := c.Locals("user").(*types.User)
    hid, err := uuid.Parse(c.Params("id"))
    if err != nil { return fiber.NewError(400, "bad id") }

    if _, err := s.Store.CheckHypothesisAccess(c.Context(), user.ID, hid, types.RoleOwner); err != nil {
        return fiber.NewError(403, "only owner can delete")
    }
    if err := s.Store.DeleteHypothesis(c.Context(), hid); err != nil {
        return fiber.NewError(500, err.Error())
    }
    return c.SendStatus(204)
}
```

### Sharing UX: by email

For 3–5 people: invite by Google email. The Admin SDK has `auth.GetUserByEmail`:

```go
fbUser, err := s.Verifier.Client.GetUserByEmail(ctx, "alice@example.com")
if err != nil { return ErrUserNotFound }
// Then ensure a row exists in our users table; fall through to insert-if-missing.
```

Then `INSERT INTO hypothesis_collaborators (hypothesis_id, user_id, role) VALUES (...)`. No invite-code dance needed — anyone you'd invite already has a Google account. If they haven't yet signed in to the app once, you can pre-create their `users` row via `auth.GetUserByEmail` and tag it as a "ghost" until first login fills `last_login_at`.

---

## 5. Custom claims as the team gate

```go
// One-time per user, run from a Cobra subcommand:
s.Verifier.Client.SetCustomUserClaims(ctx, uid, map[string]any{"team_member": true})
```

Subsequent ID tokens will carry `team_member: true` (the user must sign out / back in or the JS SDK will pick it up after refresh, which happens within an hour). The middleware's check is one line. To revoke, call `SetCustomUserClaims(ctx, uid, nil)` and optionally `RevokeRefreshTokens(ctx, uid)` to force re-login.

---

## 6. Session expiry / "remember me"

- ID tokens: 1 hour, fixed by Firebase.
- Refresh tokens: long-lived (up to 30 days of inactivity, or until revoked).
- React app handles refresh via `onIdTokenChanged` (the listener fires whenever the token rotates) and `getIdToken()` (returns cached or refreshes).
- **No backend session store.** GoAPI is stateless w.r.t. auth.
- Logout: `signOut(auth)` on the frontend clears the IndexedDB session. Backend has nothing to clear.

---

## 7. Trusted-team posture: what we need vs. what we punt

**Need:**
- HTTPS everywhere (TLS via Caddy, same as Platinum).
- `team_member` custom claim + DB allowlist as defense-in-depth.
- Audit log of who accessed/modified which hypothesis (one row per write into an `audit_log` table — `user_id, action, resource_type, resource_id, ts`).
- CSRF only matters if you switch to cookie-based auth. With Bearer headers, CSRF is a non-issue (same-origin policy + missing cookie ambient credentials = no CSRF surface).

**Punt:**
- Per-IP rate limiting (5-user team).
- Password reset / email verification (Google handles).
- CAPTCHA (no public sign-up).
- Abuse/anomaly monitoring (zerolog + manual review is enough).
- Multi-factor (Google account already has it; you inherit MFA through the OAuth flow).

---

## 8. Coexistence with Platinum's scoped-JWT pattern (sandbox callbacks)

Platinum mints a short-lived HS256 JWT with claims `{email, customer, job, session_id, scope:"agent"}` for the sandbox to call back to GoAPI. **Keep this pattern.** The sandbox should *not* use a Firebase ID token — Firebase is for human users, and you don't want to mint Firebase custom tokens for ephemeral sandbox sessions.

Two tokens, two verifiers, one middleware:

```go
func (s *HypothesisAPIServer) requireAuthMiddleware(c fiber.Ctx) error {
    raw := strings.TrimPrefix(c.Get("Authorization"), "Bearer ")

    // Try scoped HS256 JWT first (sandbox callbacks).
    if claims, err := s.ScopedJWT.Verify(raw); err == nil {
        c.Locals("scope", claims.Scope) // "agent"
        c.Locals("userID", claims.UserID)
        c.Locals("hypothesisID", claims.HypothesisID)
        return c.Next()
    }

    // Else verify as Firebase ID token (humans).
    tok, err := s.Verifier.Verify(c.Context(), raw)
    if err != nil { return fiber.NewError(401, "invalid token") }
    // ... claim check + upsert as above
    return c.Next()
}
```

Mint the scoped token when starting a sandbox session:

```go
claims := jwt.MapClaims{
  "user_id":       userID,
  "hypothesis_id": hid,
  "session_id":    sessionID,
  "scope":         "agent",
  "exp":           time.Now().Add(8 * time.Hour).Unix(),
}
tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.ScopedJWTSecret)
```

Routes intended only for sandboxes (e.g. `POST /api/v1/agent/evidence`) check `c.Locals("scope") == "agent"`. Routes for humans require a non-empty `c.Locals("user")`.

---

## 9. Migration from Platinum's username/password JWT

For hypothesis-bot this is a **fresh repo** — no migration. We simply:

- Don't port `POST /api/v1/user/login` or any password handlers.
- Don't port the `users.password_hash` column.
- Keep `pkg/auth` as the single auth package; replace `golang-jwt`-based human verification with `firebase.go`. Keep `golang-jwt` only for the scoped sandbox token.

If we ever re-imported Platinum's `AccountContext` shape, replace its `login(username, password)` call with `signInWithGoogle()` and its `token` field with `auth.currentUser`.

---

## 10. Concrete file map for hypothesis-bot

```
goapi/
  pkg/auth/firebase.go                  Verifier construction (sec. 1)
  pkg/auth/scoped_jwt.go                HS256 sandbox token mint/verify
  pkg/server/middleware_auth.go         Combined Firebase + scoped middleware (sec. 8)
  pkg/server/handler_user.go            GET /api/v1/me, POST /api/v1/me/refresh
  pkg/server/handler_collaborators.go   share/unshare endpoints (sec. 4)
  pkg/store/migrations/000001_users.go
  pkg/store/migrations/000002_hypothesis_collaborators.go
  pkg/store/users.go                    UpsertUserFromFirebase
  pkg/store/authz.go                    CheckHypothesisAccess
  cmd/admin/grant.go                    Cobra: goapi admin grant <email>
frontend/
  src/firebase.ts                       SDK init + signInWithGoogle (sec. 2)
  src/api/client.ts                     api() wrapper attaches Bearer
  src/contexts/AuthContext.tsx          onIdTokenChanged → user state
```

---

## What to copy from Platinum

1. **Server-struct dependency holding** — `HypothesisAPIServer` mirroring `PlatinumAPIServer`, now holds `Verifier *auth.Verifier`, `ScopedJWTSecret []byte`, `Store store.Store`.
2. **`requireAuthMiddleware` shape** — same name, same `c.Locals("user")` injection, same chain position.
3. **Scoped HS256 JWT for sandbox callbacks** — keep `golang-jwt/jwt/v5`, keep the `scope:"agent"` claim, keep short expiry.
4. **Handwritten Go migrations in `pkg/store/migrations/`** — `users` is `000001`, `hypothesis_collaborators` is `000002`.
5. **`typescriptify-golang-structs`** — `types.User`, `types.Role`, `types.Hypothesis` mirrored to TS automatically.
6. **Cobra admin subcommands** — `goapi admin grant <email>` to flip the `team_member` custom claim, mirroring Platinum's `pt` admin tooling.
7. **zerolog** for structured logs; audit-log writes go through the same logger plus an `audit_log` table.

## What diverges from Platinum

1. **No username/password.** No `POST /api/v1/user/login`, no password hashing, no `password_reset_tokens` table.
2. **Firebase ID token verification** in the middleware via `firebase.google.com/go/v4`, not `golang-jwt` for human auth. JWKS is cached locally; verification is per-request but offline.
3. **Token lives in memory** in the React app (Firebase JS SDK persists the *refresh* token in IndexedDB). Platinum's `AccountContext + sessionStorage` Bearer storage is gone.
4. **Allowlist via custom claims** (`team_member: true`) flipped by an admin Cobra command, rather than by inserting a row into a `users` table with a known password.
5. **Two-verifier middleware** — scoped HS256 JWTs from sandboxes still validate; Firebase ID tokens from humans validate; they're tried in that order.
6. **Sharing UX by Google email** using `auth.GetUserByEmail` in the Admin SDK, not by creating accounts in our DB and emailing credentials.
7. **No backend session/logout endpoint** — `signOut(auth)` on the frontend is the entire flow. Platinum's session-clearing endpoint is dropped.
