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
import { readFileSync } from "node:fs";
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
    expect([...found].sort()).toEqual(["VITE_GOOGLE_CLIENT_ID", "VITE_ORANGE_PUBLIC_URL"]);
  });

  it("are declared as build ARGs in web/Dockerfile's build stage, before yarn build", () => {
    const dockerfile = readFileSync(join(webRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG VITE_ORANGE_PUBLIC_URL=/m);
    expect(dockerfile).toMatch(/^ARG VITE_GOOGLE_CLIENT_ID=?/m);
    // An ARG alone is not visible to vite; only an ENV in the build stage is.
    expect(dockerfile).toMatch(/^ENV VITE_ORANGE_PUBLIC_URL=/m);
    expect(dockerfile).toMatch(/^ENV VITE_GOOGLE_CLIENT_ID=/m);
    const buildIndex = dockerfile.indexOf("RUN yarn build");
    expect(buildIndex).toBeGreaterThan(dockerfile.indexOf("ENV VITE_ORANGE_PUBLIC_URL"));
    expect(buildIndex).toBeGreaterThan(dockerfile.indexOf("ENV VITE_GOOGLE_CLIENT_ID"));
  });

  it("are passed to wolf-web through docker-compose build.args", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const webBlock = compose.slice(compose.indexOf("\n  wolf-web:"));
    expect(webBlock).toMatch(/\n {6}args:\n/);
    expect(webBlock).toMatch(/VITE_ORANGE_PUBLIC_URL: \$\{VITE_ORANGE_PUBLIC_URL/);
    expect(webBlock).toMatch(/VITE_GOOGLE_CLIENT_ID: \$\{VITE_GOOGLE_CLIENT_ID/);
  });

  it("are documented in .env.example", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^VITE_ORANGE_PUBLIC_URL=/m);
    expect(example).toMatch(/^VITE_GOOGLE_CLIENT_ID=/m);
  });
});

describe("the Go Live gate has exactly one source", () => {
  it("web/ imports no spec validator", () => {
    const offenders = sourceFiles().filter((file) => {
      const text = readFileSync(file, "utf8");
      return /\bvalidateSpec\b|hypothesis\/spec/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe("no Orange origin is hard-coded outside env.ts", () => {
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
