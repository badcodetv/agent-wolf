/**
 * Shared test scaffolding for `web/`'s component and page suites.
 *
 * ## Why `fetch` is stubbed rather than intercepted with undici's `MockAgent`
 *
 * The plan pins `undici` `MockAgent` for HTTP mocking, and that is the right
 * tool in `api/` — a Node process making absolute-URL requests. It does not
 * fit here, and the reason is not preference:
 *
 *   - `web/` calls RELATIVE paths (`/api/hypotheses`), because nginx and the
 *     vite dev proxy both forward `/api` on the page's own origin. Node's
 *     `fetch` cannot parse a relative URL at all, so a `MockAgent` never even
 *     sees the request — it fails in `new Request()` first.
 *   - Making the client build absolute URLs so a `MockAgent` could intercept
 *     them would mean inventing a second origin for the API, which is exactly
 *     what the relative-path topology exists to avoid.
 *
 * The rule the pin protects — **no live network in any unit test** — is kept:
 * `stubFetchRoutes` replaces the global outright and THROWS on an unrouted
 * path, so a request this file did not anticipate fails loudly instead of
 * reaching the network or returning undefined.
 */

import type { ReactElement, ReactNode } from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, vi } from "vitest";
import { lightTheme } from "./theme.js";

/** One stubbed response. `status` defaults to 200. */
export interface StubResponse {
  status?: number;
  json?: unknown;
  /** Raw body, for the non-JSON bodies Express answers unmounted routes with. */
  text?: string;
}

/**
 * A route table for the stubbed `fetch`. The key is `"<METHOD> <path>"`, e.g.
 * `"GET /api/hypotheses"`. The value is either a response or a function of the
 * call index, so a test can hand out a different token on each mint.
 */
export type FetchRoutes = Record<
  string,
  StubResponse | ((callIndex: number, init: RequestInit | undefined) => StubResponse)
>;

export interface FetchStub {
  /** The vitest mock, for `toHaveBeenCalledTimes` and friends. */
  mock: ReturnType<typeof vi.fn>;
  /** Every `"<METHOD> <path>"` requested, in order. */
  calls: string[];
  /** How many requests matched one key. */
  countFor(key: string): number;
}

function toResponse(stub: StubResponse): Response {
  const status = stub.status ?? 200;
  const body =
    stub.text !== undefined ? stub.text : stub.json === undefined ? "" : JSON.stringify(stub.json);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => {
      if (stub.json === undefined) throw new SyntaxError("not JSON");
      return stub.json;
    },
    text: async () => body,
  } as unknown as Response;
}

export function stubFetchRoutes(routes: FetchRoutes): FetchStub {
  const calls: string[] = [];
  const perKey = new Map<string, number>();

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${path}`;
    calls.push(key);
    const index = perKey.get(key) ?? 0;
    perKey.set(key, index + 1);

    const route = routes[key];
    if (route === undefined) {
      // Loud, not silent: an unrouted request is a test that does not know
      // what its subject does, and returning a default would hide it.
      throw new Error(`no stubbed route for ${key}; stubbed: ${Object.keys(routes).join(", ")}`);
    }
    return toResponse(typeof route === "function" ? route(index, init) : route);
  });

  vi.stubGlobal("fetch", mock);

  return {
    mock,
    calls,
    countFor: (key: string) => calls.filter((call) => call === key).length,
  };
}

/** Renders under Wolf's theme and a router, the way `main.tsx` and `App.tsx` do in the browser. */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & { route?: string } = {},
): RenderResult {
  const { route = "/", ...rest } = options;
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider theme={lightTheme}>
        <CssBaseline />
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </ThemeProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...rest });
}

/**
 * Asserts nothing was written to either web storage.
 *
 * The embed token lives in COMPONENT STATE ONLY. A token in `localStorage` is
 * readable by any script on the origin and survives the tab, and an Orange
 * embed token carries project-wide authority for its lifetime
 * (`docs/19-embedding.md`, hazard H1) — so persisting one widens the blast
 * radius of an XSS from "this render" to "until it expires, everywhere".
 */
export function expectNothingPersisted(): void {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
}
