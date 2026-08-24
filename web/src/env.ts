/**
 * The ONE place `import.meta.env` is read (W13, § "Acceptance criteria":
 * "read **only** in `web/src/env.ts`").
 *
 * `wolf-web` ships as a BUILT nginx image and cannot read runtime
 * environment: nginx serves static files, and by the time a browser has the
 * bundle every `import.meta.env.VITE_*` in it has already been replaced by a
 * string literal at build time. So both values below are **build args** —
 * `web/Dockerfile` declares them as `ARG`/`ENV` in the build stage,
 * `docker-compose.yml` passes them through `build.args` on `wolf-web`, and
 * `.env.example` documents them. W13's Validation proves the chain
 * empirically rather than declaratively: it builds the image with
 * `--build-arg VITE_ORANGE_PUBLIC_URL=http://localhost:8090` and greps the
 * served bundle for that literal, which no config dump can establish.
 *
 * Both are read INSIDE the functions, not at module load. Vite still replaces
 * them statically (that is what makes the grep above work), and reading at
 * call time is what lets a test stub the variable with `vi.stubEnv` and prove
 * the value is composed rather than hard-coded.
 */

interface WolfImportMetaEnv {
  /** Orange's BROWSER-reachable origin — the base of the chat embed URL. */
  readonly VITE_ORANGE_PUBLIC_URL?: string;
  /** The Google Identity Services client id used by the sign-in page. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly MODE?: string;
}

function env(): WolfImportMetaEnv {
  return import.meta.env as unknown as WolfImportMetaEnv;
}

/**
 * The default Orange public origin: agent-orange's own compose stack
 * publishes its `web` service on 8080. Matches `api/src/config.ts`'s
 * `DEFAULT_ORANGE_PUBLIC_URL` and `web/Dockerfile`'s `ARG` default.
 *
 * ⚠️ It must be the same origin as the API's `ORANGE_PUBLIC_URL`, and it must
 * appear in the `wolf` project's `allowed_origins` in Orange's project map —
 * the embed page's `frame-ancestors` CSP is built from that list, so an
 * origin missing there means the browser blocks the chat rail outright, with
 * no error on the Wolf side at all.
 */
export const DEFAULT_ORANGE_PUBLIC_URL = "http://localhost:8080";

/** Trailing slashes trimmed, so callers concatenate a path without doubling the separator. */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Orange's browser-reachable origin, without a trailing slash.
 *
 * Plain concatenation is used at the call sites rather than `new URL()`: a
 * base carrying a path prefix (`https://example.test/orange`) survives
 * concatenation and is silently truncated by `new URL("/embed/…", base)`.
 * `api/src/routes/embed.ts`'s `embedUrlFor` makes the same choice for the
 * same reason.
 */
export function orangePublicUrl(): string {
  const raw = env().VITE_ORANGE_PUBLIC_URL;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimTrailingSlashes(trimmed === "" ? DEFAULT_ORANGE_PUBLIC_URL : trimmed);
}

/**
 * The Google Identity Services client id, or `undefined` when it was not
 * built in. Undefined is a legitimate state, not an error: an offline stack
 * signs in through `POST /api/auth/dev-login` (mounted only when
 * `WOLF_TEST_LOGIN` is set), and the sign-in page says so rather than
 * rendering a Google button that cannot work.
 */
export function googleClientId(): string | undefined {
  const raw = env().VITE_GOOGLE_CLIENT_ID;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}
