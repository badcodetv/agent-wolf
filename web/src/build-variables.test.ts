// @vitest-environment node
//
// Three rules that are properties of the TREE, not of any one module, and each
// of which fails silently at runtime if it breaks:
//
//  1. The two `VITE_*` build variables are read in exactly one file. A second
//     reader is how a value ends up configured in one place and hard-coded in
//     another, with only one of them updated.
//  2. `web/` never imports the spec validator. The Go Live gate has exactly
//     one source — `spec_validation` on the detail payload — and W1's import
//     boundary would happily permit a second one.
//  3. The build args are actually WIRED: declared in `web/Dockerfile`, passed
//     by `docker-compose.yml`, documented in `.env.example`. `wolf-web` ships
//     as a built nginx image, so a variable that is not a build arg simply
//     never reaches the bundle — and nothing fails, the origin is just wrong.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceFiles } from "@wolf/import-boundary";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/
const ENV_MODULE = join(webRoot, "src", "env.ts");

function sourceFiles(): string[] {
  return collectSourceFiles(join(webRoot, "src"));
}

describe("the two VITE_* build variables", () => {
  it("are read through `import.meta.env` in exactly one source file: src/env.ts", () => {
    // Grepping for the VARIABLE NAMES would flag every doc comment that
    // explains them, which is not the hazard. The hazard is a second READER:
    // `import.meta.env` anywhere but the one module.
    const allowed = new Set([
      ENV_MODULE,
      // W28's `Severity` reads MODE/PROD to decide whether a missing cause
      // throws (developer) or renders nothing (production). Not a VITE_
      // variable, not configuration, and not this ticket's to move.
      join(webRoot, "src", "components", "trust", "Severity.tsx"),
      // …and its own test, which stubs MODE to prove both branches.
      join(webRoot, "src", "components", "trust", "Severity.test.tsx"),
      // This suite names the expression in order to forbid it elsewhere.
      join(webRoot, "src", "build-variables.test.ts"),
    ]);
    const offenders = sourceFiles().filter(
      (file) => !allowed.has(file) && /import\.meta\.env/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("are the only two — no third VITE_ variable has crept in", () => {
    const text = readFileSync(ENV_MODULE, "utf8");
    const found = new Set(text.match(/VITE_[A-Z0-9_]+/g) ?? []);
    expect([...found].sort()).toEqual(["VITE_BOB_PUBLIC_URL", "VITE_GOOGLE_CLIENT_ID"]);
  });

  it("are declared as build ARGs in web/Dockerfile's build stage, before yarn build", () => {
    const dockerfile = readFileSync(join(webRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG VITE_BOB_PUBLIC_URL=/m);
    expect(dockerfile).toMatch(/^ARG VITE_GOOGLE_CLIENT_ID=?/m);
    // An ARG alone is not visible to vite; only an ENV in the build stage is.
    expect(dockerfile).toMatch(/^ENV VITE_BOB_PUBLIC_URL=/m);
    expect(dockerfile).toMatch(/^ENV VITE_GOOGLE_CLIENT_ID=/m);
    const buildIndex = dockerfile.indexOf("RUN yarn build");
    expect(buildIndex).toBeGreaterThan(dockerfile.indexOf("ENV VITE_BOB_PUBLIC_URL"));
    expect(buildIndex).toBeGreaterThan(dockerfile.indexOf("ENV VITE_GOOGLE_CLIENT_ID"));
  });

  it("are passed to wolf-web through docker-compose build.args", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const webBlock = compose.slice(compose.indexOf("\n  wolf-web:"));
    expect(webBlock).toMatch(/\n {6}args:\n/);
    expect(webBlock).toMatch(/VITE_BOB_PUBLIC_URL: \$\{VITE_BOB_PUBLIC_URL/);
    expect(webBlock).toMatch(/VITE_GOOGLE_CLIENT_ID: \$\{VITE_GOOGLE_CLIENT_ID/);
  });

  it("are documented in .env.example", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^VITE_BOB_PUBLIC_URL=/m);
    expect(example).toMatch(/^VITE_GOOGLE_CLIENT_ID=/m);
  });
});

/**
 * Comments are stripped before the validator guard below runs.
 *
 * ⚠️ **Narrowed 2026-08-24 (W14).** The guard used to grep raw file text, so a
 * doc comment CITING the API's validator — which is exactly what a comment
 * explaining why `web/` does not import it looks like — failed the suite. W14
 * reworded three of its own doc comments to get past it, which is the wrong
 * outcome twice over: it made the documentation worse, and a guard that
 * teaches authors to obfuscate their prose stops describing the tree.
 *
 * The hazard was never the word. It is the IMPORT, and this file already
 * reasons that way about `VITE_*` above: "grepping for the variable NAMES
 * would flag every doc comment, which is not the hazard".
 *
 * Stripping over-eagerly is the SAFE direction here — it can only leave the
 * guard stricter than intended on a line it mangles, never blinder. The one
 * case it could hide is an import whose own line contains `//`, i.e. a URL
 * specifier, and W1's import boundary already forbids those.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}

/** True when a file IMPORTS the spec validator, as opposed to mentioning it. */
export function importsSpecValidator(text: string): boolean {
  return /\bvalidateSpec\b|hypothesis\/spec/.test(stripComments(text));
}

describe("the Go Live gate has exactly one source", () => {
  it("web/ imports no spec validator", () => {
    const offenders = sourceFiles().filter((file) =>
      importsSpecValidator(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  // The specifier, the symbol AND the keywords are all assembled from parts,
  // never written as literals. This file is scanned by the check above — and
  // by the sibling boundary suite, whose specifier regex has no word boundary
  // and no notion of a string: any occurrence of the two module keywords
  // followed by a quote is a specifier to it. Writing the fixture plainly
  // produces a violation naming a nonsense package, which reads as a bug in
  // the checker rather than as a bug here. Same rule, and the same reason, as
  // the `.jsx` regression case in the boundary suite. That also rules the
  // keywords out of the test TITLES below: a title ending in one of them sits
  // directly against its own closing quote and matches too.
  const specModule = ["..", "..", "api", "src", "hypothesis", "spec.js"].join("/");
  const validator = ["validate", "Spec"].join("");
  const kwImport = ["im", "port"].join("");
  const kwExport = ["ex", "port"].join("");
  const kwFrom = ["fr", "om"].join("");

  it("still catches a real static or dynamic specifier", () => {
    expect(importsSpecValidator(`${kwImport} { ${validator} } ${kwFrom} "${specModule}";`)).toBe(true);
    expect(importsSpecValidator(`const v = await ${kwImport}("${specModule}");`)).toBe(true);
    expect(importsSpecValidator(`${kwExport} { ${validator} } ${kwFrom} "${specModule}";`)).toBe(true);
  });

  it("no longer fails a doc comment that CITES the validator", () => {
    const jsdoc = [
      "/**",
      ` * The gate is server-side: the API runs ${validator} and sends`,
      ` * spec_validation. See ${specModule} — web/ never pulls it in.`,
      " */",
      "export const GATE = 'spec_validation';",
    ].join("\n");
    expect(importsSpecValidator(jsdoc)).toBe(false);
    expect(importsSpecValidator(`const x = 1; // ${validator} lives in ${specModule}`)).toBe(false);
  });

  it("does not treat a URL's // as a comment", () => {
    expect(stripComments('const u = "https://example.test/x";')).toContain("example.test/x");
  });
});

/**
 * 🔴 Nothing in this tree looked at BYTES until W14, and a source file that is
 * not text passes every gate.
 *
 * A stray NUL landed in `MetricCharts.tsx` while it was being written (a
 * `join()` separator). `tsc`, `vite build` and the whole vitest suite stayed
 * green — a NUL inside a comment or a string is legal to all three — and the
 * only symptom was `git diff` reporting `Bin 0 -> 5776 bytes` and refusing to
 * show the file. A reviewer reading diffs would have seen nothing at all.
 */
describe("every source file is text", () => {
  const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR

  function hasControlBytes(bytes: Uint8Array): boolean {
    return bytes.some((b) => (b < 0x20 && !ALLOWED_CONTROL_BYTES.has(b)) || b === 0x7f);
  }

  it("carries no NUL or other control byte", () => {
    const offenders = sourceFiles().filter((file) => hasControlBytes(readFileSync(file)));
    expect(offenders).toEqual([]);
  });

  it("regression: the scan really does flag a NUL", () => {
    // Written to a temp directory, so it never pollutes the real source tree
    // or the file list the check above walks.
    const scratch = mkdtempSync(join(tmpdir(), "wolf-control-bytes-"));
    try {
      const poisoned = join(scratch, "Poisoned.ts");
      writeFileSync(poisoned, Buffer.from([0x65, 0x00, 0x6e]));
      expect(hasControlBytes(readFileSync(poisoned))).toBe(true);
      const clean = join(scratch, "Clean.ts");
      writeFileSync(clean, "export const ok = 1;\n\tindented\r\n", "utf8");
      expect(hasControlBytes(readFileSync(clean))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("no Bob origin is hard-coded outside env.ts", () => {
  it("names localhost:8080 only where the default lives", () => {
    const offenders = sourceFiles().filter((file) => {
      if (file === ENV_MODULE || file === join(webRoot, "src", "env.test.ts")) return false;
      // This suite quotes the default in order to assert it is not quoted
      // anywhere else.
      if (file === join(webRoot, "src", "build-variables.test.ts")) return false;
      return /localhost:8080/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
