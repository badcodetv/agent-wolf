// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria (owner decision
// 2026-08-21, R40): vitest 4's `dependencies.vite` (not just its peer
// range) is the literal string "^6.0.0 || ^7.0.0 || ^8.0.0" — a DIFFERENT
// range string from web/package.json's own "^6.4.3" devDependency. Yarn
// classic resolves each distinct range string independently rather than
// reusing an already-resolved compatible version, so without the root
// package.json `resolutions` pin, it installs vite 6.4.3 at the repo root
// AND a second, newer vite (8.x at the time this was written) nested under
// vitest/node_modules to satisfy its own dependency range — meaning
// `vitest run` and `vite build` evaluate web/vite.config.ts under two
// different resolvers. This asserts the nested copy stays absent, at
// BOTH the location the criterion names (web/node_modules/...) and the
// location yarn's hoisting actually puts it (the repo root's
// node_modules/...) — see the guesses recorded for this ticket.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/

const NESTED_VITE_RELATIVE = join("node_modules", "vitest", "node_modules", "vite");

describe("dependency hygiene", () => {
  it("has no nested vitest/node_modules/vite copy under web/node_modules", () => {
    expect(existsSync(join(webRoot, NESTED_VITE_RELATIVE))).toBe(false);
  });

  it("has no nested vitest/node_modules/vite copy under the workspace root's node_modules (yarn classic's actual hoist location)", () => {
    expect(existsSync(join(repoRoot, NESTED_VITE_RELATIVE))).toBe(false);
  });

  it("web/package.json declares vite ^6.x, not ^5.x (deliberately diverges from examples/web's vite 5 — vitest 4's peer range is vite 6+)", () => {
    const manifest = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.vite).toMatch(/^\^?6\./);
  });

  it("react, react-dom and react-is are pinned exactly (no caret), matching examples/web's form", () => {
    const manifest = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.react).toBe("18.3.1");
    expect(manifest.dependencies?.["react-dom"]).toBe("18.3.1");
    expect(manifest.dependencies?.["react-is"]).toBe("18.3.1");
  });

  it("the root package.json pins vite via resolutions, which is why the nested copy is actually absent", () => {
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      resolutions?: Record<string, string>;
    };
    expect(rootManifest.resolutions?.vite).toMatch(/^6\./);
  });
});
