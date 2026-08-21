# Supabase Auth + Go Fiber v3 — Multi-User Brief for Hypothesis-Bot

> Goal: replace Platinum's custom username/password JWT auth with **Supabase Auth** (Google OAuth) for hypothesis-bot, a 3–5-user trusted-team app. Auth and the data store share a vendor (we already chose Supabase Postgres in [`06`](06-storage-architecture.md)). The verifier is ~30 lines of Go and pulls in **no external SDK**. Keep Platinum's `requireAuthMiddleware` shape and server-struct dependency holding; drop the custom username/password handlers and the scoped HS256 callback JWT (the KISS pass removes per-session sandbox callbacks — see [`07`](07-claude-code-orchestration.md) and [`09`](09-kiss-architecture-decision.md)).
>
> **2026-05-09 update:** this brief replaces the earlier Firebase Auth recommendation. We dropped Firebase to consolidate on a single auth+data vendor. The middleware shape is identical — only the verifier code changes.

---

## 1. Why Supabase Auth (not Firebase, not raw Google OAuth)

- **Already in the stack.** Supabase is our DB host. Adopting its bundled Auth (GoTrue) means one vendor, one console, one onboarding flow.
- **Free tier covers us.** 50,000 monthly active users on Supabase Auth's free tier. We have 3–5.
- **Google OAuth is a one-click provider** in the Supabase dashboard. The frontend uses `@supabase/supabase-js` to launch the OAuth flow.
- **JWT verification is local + zero-dependency.** Supabase issues HS256-signed JWTs using the project's `SUPABASE_JWT_SECRET`. The Go side verifies signature with `golang-jwt/jwt v5` — no SDK, no JWKS fetch, no per-request network round-trip.
- **Custom claims are server-managed.** `app_metadata` (write-only via service-role key) is exactly the place to put `role: "operator" | "editor" | "viewer"`.

Trade-offs noted: auth + data now share a vendor (lock-in). Mitigated because the only Supabase-specific code is the JWT verifier (~30 LOC); swap-out cost is rewriting one Go file.

---

## 2. Go-side verifier

`goapi/pkg/auth/supabase.go`:

```go
package auth

import (
    "errors"
    "fmt"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type Verifier struct {
    secret []byte
}

func NewVerifier(jwtSecret string) *Verifier {
    return &Verifier{secret: []byte(jwtSecret)}
}

type Claims struct {
    Sub          string         `json:"sub"`           // Supabase UID
    Email        string         `json:"email"`
    Role         string         `json:"role"`          // Postgres role; usually "authenticated"
    AppMetadata  map[string]any `json:"app_metadata"`  // server-managed; carries our role enum
    UserMetadata map[string]any `json:"user_metadata"` // user-editable; ignored
    jwt.RegisteredClaims
}

func (v *Verifier) Verify(raw string) (*Claims, error) {
    tok, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
        if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
        }
        return v.secret, nil
    }, jwt.WithLeeway(30*time.Second))
    if err != nil {
        return nil, err
    }
    c, ok := tok.Claims.(*Claims)
    if !ok || !tok.Valid {
        return nil, errors.New("invalid token")
    }
    return c, nil
}

func (c *Claims) AppRole() string {
    if v, ok := c.AppMetadata["role"].(string); ok {
        return v
    }
    return "viewer"
}
```

Init from envconfig:

```go
type AuthConfig struct {
    SupabaseJWTSecret string `envconfig:"SUPABASE_JWT_SECRET" required:"true"`
}
```

The secret is found in the Supabase dashboard → Settings → API → JWT Secret. Rotating it rotates everyone's tokens.

---

## 3. Fiber v3 middleware

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
    raw := strings.TrimPrefix(h, "Bearer ")

    claims, err := s.Verifier.Verify(raw)
    if err != nil {
        log.Debug().Err(err).Msg("supabase verify failed")
        return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
    }

    user, err := s.Store.UpsertUserFromSupabase(c.Context(), claims)
    if err != nil {
        return fiber.NewError(fiber.StatusInternalServerError, "user upsert failed")
    }
    c.Locals("user", user)
    c.Locals("role", claims.AppRole())
    return c.Next()
}

// requireOperator is composed onto routes that trigger LLM workflows.
func (s *HypothesisAPIServer) requireOperator(c fiber.Ctx) error {
    if c.Locals("role") != "operator" {
        return fiber.NewError(fiber.StatusForbidden, "operator only")
    }
    return c.Next()
}
```

Token refresh on the backend: nothing to do. The Supabase JS SDK on the client transparently refreshes the access token roughly every hour using the long-lived refresh token.

---

## 4. Frontend integration (React 18 + Vite)

```
yarn add @supabase/supabase-js
```

`frontend/src/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export const signInWithGoogle = () =>
  supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
```

### Where the token lives

The Supabase JS SDK persists the **refresh token** in `localStorage` by default (configurable to `sessionStorage` or memory via `auth.persistSession` / `auth.storage`). We rely on the SDK; access tokens are read on demand:

```ts
// frontend/src/api/client.ts
import { supabase } from "../supabase";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("not signed in");

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (res.status === 401) {
    const { data: { session: refreshed } } = await supabase.auth.refreshSession();
    if (!refreshed) throw new Error("session refresh failed");
    return api(path, { ...init, headers: { ...(init.headers||{}), Authorization: `Bearer ${refreshed.access_token}` } });
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

Wire this into TanStack Query as the `queryFn`/`mutationFn` body.

### Restricting to a list of allowed emails

Two complementary mechanisms:

1. **Supabase dashboard email allowlist** under Auth → Providers → Google → "Restrict to specific email domains" (or via the `auth.email.signups_disabled` toggle plus a manual invite-only flow). Stops a Google user from getting an account in the first place.
2. **`app_metadata.role`** server-set after invite. Only users with `role ∈ {"operator","editor","viewer"}` are accepted by the middleware on protected routes. Users without the claim get a 403.

Bootstrap is a Cobra command:

```go
// cmd/admin/setrole.go
err := s.SupabaseAdmin.SetUserAppMetadata(ctx, uid, map[string]any{"role": "editor"})
```

`SupabaseAdmin` wraps Supabase's Admin REST API at `/auth/v1/admin/users/<uid>` using the service-role key. There's no first-party Go SDK; a ~50-LOC `net/http` client suffices.

---

## 5. User model in Postgres

Schema:

```sql
CREATE TYPE app_role AS ENUM ('operator','editor','viewer');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_uid  UUID UNIQUE NOT NULL,             -- matches auth.users.id in Supabase
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  photo_url     TEXT,
  role          app_role NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users(email);
```

Note: `users.role` is the *application* role and is the source of truth in our DB. `app_metadata.role` is its mirror in the Supabase JWT (so middleware can gate without a DB hit). The Cobra `set-role` command writes both.

`goapi/pkg/store/migrations/000001_users.go` mirrors Platinum's handwritten Go-migration shape.

### Upsert pattern on first login

```go
// goapi/pkg/store/users.go
func (s *Store) UpsertUserFromSupabase(ctx context.Context, c *auth.Claims) (*types.User, error) {
    fullName, _ := c.UserMetadata["full_name"].(string)
    avatar, _   := c.UserMetadata["avatar_url"].(string)

    var u types.User
    err := s.pg.QueryRow(ctx, `
      INSERT INTO users (supabase_uid, email, display_name, photo_url, role)
      VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'viewer')::app_role)
      ON CONFLICT (supabase_uid) DO UPDATE
        SET email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            photo_url = EXCLUDED.photo_url,
            last_login_at = now()
      RETURNING id, supabase_uid, email, display_name, photo_url, role, created_at, last_login_at;`,
      c.Sub, c.Email, fullName, avatar, c.AppRole(),
    ).Scan(&u.ID, &u.SupabaseUID, &u.Email, &u.DisplayName, &u.PhotoURL, &u.Role, &u.CreatedAt, &u.LastLoginAt)
    return &u, err
}
```

`GET /api/v1/me` is a one-liner that returns `c.Locals("user")` as JSON.

---

## 6. Multi-user collaboration data model

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

Two role enums, intentionally:

- **`users.role`** (`app_role`) — system-wide capability gate. Can this user trigger LLM workflows at all? Only `operator` can.
- **`hypothesis_collaborators.role`** (`collab_role`) — per-hypothesis access. Can this user edit *this* hypothesis? Orthogonal to `users.role`: an operator may be only a viewer on a given hypothesis; an editor may be the owner of one.

The owner is a row in this table *as well as* `hypotheses.owner_id` — keeps queries uniform. On hypothesis create, insert both rows in the same transaction.

### Authorization helpers

```go
// goapi/pkg/store/authz.go
func (s *Store) CheckHypothesisAccess(
    ctx context.Context, userID, hypothesisID uuid.UUID, minRole types.CollabRole,
) (types.CollabRole, error) {
    var role types.CollabRole
    err := s.pg.QueryRow(ctx,
      `SELECT role FROM hypothesis_collaborators WHERE hypothesis_id=$1 AND user_id=$2`,
      hypothesisID, userID,
    ).Scan(&role)
    if err != nil { return "", ErrForbidden }
    if !role.Satisfies(minRole) { return role, ErrForbidden }
    return role, nil
}
```

`CollabRole.Satisfies` orders `viewer < editor < owner`.

### Canonical handler

```go
func (s *HypothesisAPIServer) deleteHypothesis(c fiber.Ctx) error {
    user := c.Locals("user").(*types.User)
    hid, err := uuid.Parse(c.Params("id"))
    if err != nil { return fiber.NewError(400, "bad id") }

    if _, err := s.Store.CheckHypothesisAccess(c.Context(), user.ID, hid, types.CollabRoleOwner); err != nil {
        return fiber.NewError(403, "only owner can delete")
    }
    if err := s.Store.DeleteHypothesis(c.Context(), hid); err != nil {
        return fiber.NewError(500, err.Error())
    }
    return c.SendStatus(204)
}
```

Operator-only handlers compose `requireOperator` after `requireAuthMiddleware`:

```go
v1.Post("/hypotheses/:id/spec-generate", s.requireAuthMiddleware, s.requireOperator, s.runSpecGen)
v1.Post("/hypotheses/:id/tick-now",       s.requireAuthMiddleware, s.requireOperator, s.runTickNow)
```

### Sharing UX: by email

For 3–5 people: invite by Google email. Look up the existing user row by email; if missing, prefetch it via Supabase Admin's `GET /auth/v1/admin/users?email=…` and insert a stub. Then `INSERT INTO hypothesis_collaborators (...)`. No invite-code dance — invitees already have Google accounts.

---

## 7. Trusted-team posture: what we need vs. what we punt

**Need:**
- HTTPS everywhere (TLS via Caddy, same as Platinum).
- `users.role` + `app_metadata.role` mirroring as the operator gate.
- Audit log of who triggered each LLM workflow (`tick_runs.triggered_by_user_id`, `spec_runs.triggered_by_user_id`).
- CSRF only matters if you switch to cookie-based auth. With Bearer headers, CSRF is a non-issue.

**Punt:**
- Per-IP rate limiting (5-user team).
- Password reset / email verification (Google handles).
- CAPTCHA (no public sign-up).
- Multi-factor (Google account already has it).
- Revocation flow beyond `set-role viewer` + Supabase dashboard.

---

## 8. What changed vs. the Firebase plan (and what didn't)

**Changed:**
- Verifier: ~30 LOC `golang-jwt`-based HS256 verifier instead of `firebase.google.com/go/v4` SDK + JWKS fetcher.
- Frontend SDK: `@supabase/supabase-js` instead of `firebase`.
- Custom claim location: `app_metadata.role` instead of top-level `team_member: true`.
- Admin command: `goapi admin set-role <email> <role>` (writes both DB and Supabase) replaces `goapi admin grant <email>` (Firebase custom-claim flipper). Plus `goapi admin set-operator <email>` as a convenience that sets `role='operator'` exactly once.
- `users.supabase_uid` column instead of `users.firebase_uid`.

**Removed:**
- Two-verifier middleware (scoped HS256 callback JWT). The KISS pass eliminated sandbox→GoAPI callbacks ([`09`](09-kiss-architecture-decision.md)), so there's no second token type to verify. `goapi/pkg/auth/scoped_jwt.go` is gone.

**Unchanged:**
- `requireAuthMiddleware` shape and `c.Locals("user")` injection.
- `users` + `hypothesis_collaborators` schema (only `firebase_uid` → `supabase_uid` rename and the new `users.role` column).
- Sharing-by-email UX.
- HTTPS/CSRF/MFA posture.
- Server-struct dependency holding (`HypothesisAPIServer.Verifier`, `.Store`, `.Jobs`).

---

## 9. Concrete file map for hypothesis-bot

```
goapi/
  pkg/auth/supabase.go                  Verifier (sec. 2)
  pkg/auth/admin.go                     SupabaseAdmin REST wrapper (sec. 4)
  pkg/server/middleware_auth.go         requireAuthMiddleware + requireOperator (sec. 3)
  pkg/server/handler_user.go            GET /api/v1/me
  pkg/server/handler_collaborators.go   share/unshare endpoints (sec. 6)
  pkg/store/migrations/000001_users.go
  pkg/store/migrations/000003_hypothesis_collaborators.go
  pkg/store/users.go                    UpsertUserFromSupabase
  pkg/store/authz.go                    CheckHypothesisAccess
  cmd/admin/setrole.go                  Cobra: goapi admin set-role <email> <role>
  cmd/admin/setoperator.go              Cobra: goapi admin set-operator <email>
frontend/
  src/supabase.ts                       SDK init + signInWithGoogle (sec. 4)
  src/api/client.ts                     api() wrapper attaches Bearer
  src/contexts/AuthContext.tsx          onAuthStateChange → user state
```

---

## What to copy from Platinum

1. **Server-struct dependency holding** — `HypothesisAPIServer` mirroring `PlatinumAPIServer`, now holds `Verifier *auth.Verifier`, `SupabaseAdmin *auth.SupabaseAdmin`, `Store store.Store`, `Jobs *river.Client`.
2. **`requireAuthMiddleware` shape** — same name, same `c.Locals("user")` injection, same chain position.
3. **Handwritten Go migrations in `pkg/store/migrations/`** — `users` is `000001`, `hypotheses` is `000002`, `hypothesis_collaborators` is `000003`.
4. **`typescriptify-golang-structs`** — `types.User`, `types.AppRole`, `types.CollabRole`, `types.Hypothesis` mirrored to TS automatically.
5. **Cobra admin subcommands** — `goapi admin set-role`, `goapi admin set-operator`, `goapi admin grant-collab` mirroring Platinum's `pt` admin tooling.
6. **zerolog** for structured logs; audit-log writes go through the same logger plus an `audit_log` table.

## What diverges from Platinum

1. **No username/password.** No `POST /api/v1/user/login`, no password hashing.
2. **Supabase JWT verification** in the middleware via `golang-jwt/jwt v5` against `SUPABASE_JWT_SECRET`. JWKS not needed (HS256, secret-based).
3. **Token refresh handled by `@supabase/supabase-js` on the frontend.** Platinum's `AccountContext + sessionStorage` pattern is gone.
4. **Role gate is two-layered** — `users.role` (capability) and `hypothesis_collaborators.role` (per-resource). Platinum has only the latter.
5. **No backend session/logout endpoint** — `supabase.auth.signOut()` on the frontend is the entire flow.
