// Regression fixtures for the three failures the round-4 escalation named
// against tools/import-boundary/src/index.ts (design/2026-08-20-agent-wolf.md,
// W1 Notes — F1/F2/F3). Each test builds a throwaway, fully isolated
// fixture repo (never the real web/api trees) so a planted violation can be
// asserted caught without touching real source.
//
// This file lives under api/src and is therefore itself scanned by
// api/src/import-boundary.test.ts's real checks. A literal, contiguous
// import or require keyword sitting directly against a quote character in
// THIS file's own checked-in text would trip that suite against itself —
// exactly the trap web/src/import-boundary.test.ts's own regression case
// documents (and its own prose deliberately avoids the same way: no quote
// character sits directly after either keyword anywhere below). Every
// fixture specifier below is assembled from parts at runtime and only ever
// written into a temp file; it never appears as a literal matchable token
// in this file's own source.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkImportBoundary } from "@wolf/import-boundary";

const IMPORT_WORD = ["im", "port"].join("");
const REQUIRE_WORD = ["requi", "re"].join("");
const FROM_WORD = ["fr", "om"].join("");
const BACKTICK = String.fromCharCode(96);

// Climbs far enough above any plausible temp-dir nesting that the resolved
// target is guaranteed outside the fixture repo root regardless of where
// tmpdir() lives on this machine (same technique as the existing .jsx
// regression case in web/src/import-boundary.test.ts).
const OUTSIDE_SPECIFIER = [
  "..", "..", "..", "..", "..", "..", "..", "..", "..", "..",
  "outside-the-repo", "leak-target",
].join("/");

function makeFixtureRepo(): { repoRoot: string; srcDir: string; packageManifestPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "wolf-import-boundary-fixture-"));
  const srcDir = join(repoRoot, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "export {};\n", "utf8");
  const packageManifestPath = join(repoRoot, "package.json");
  writeFileSync(packageManifestPath, JSON.stringify({ dependencies: {}, devDependencies: {} }), "utf8");
  return { repoRoot, srcDir, packageManifestPath };
}

describe("import-boundary checker: F1/F2/F3 closures (W1 round-4 escalation)", () => {
  // F1 — root config files (web/vite.config.ts, api/vitest.config.ts) were
  // never scanned: checkImportBoundary walked only srcDir. A leak planted
  // in a root config file — stood in for here by a file sitting beside
  // (not under) srcDir — must be scanned and rejected exactly like a
  // src/ file would be.
  it("F1: scans a root config file outside srcDir and rejects an outside-the-repo import in it", async () => {
    const { repoRoot, srcDir, packageManifestPath } = makeFixtureRepo();
    try {
      const configFile = join(repoRoot, "vite.config.ts"); // sibling of srcDir, not inside it
      writeFileSync(configFile, `${IMPORT_WORD} { evil } ${FROM_WORD} "${OUTSIDE_SPECIFIER}";\n`, "utf8");

      const report = await checkImportBoundary({
        label: "fixture",
        srcDir,
        repoRoot,
        packageManifestPath,
        rootManifestPath: packageManifestPath,
        tsconfigPaths: [],
        rootConfigFiles: [configFile],
      });

      expect(report.files).toContain(configFile);
      expect(report.relativeViolations.some((v) => v.includes(configFile))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // F2 — the bare-specifier rule only consulted `declared` when node_modules
  // resolution FAILED. A package present in node_modules (here planted
  // directly, standing in for a package merely hoisted by someone else's
  // dependency) but declared in no manifest passed silently. The criterion
  // requires declaration, not mere resolvability.
  it("F2: rejects a bare specifier that resolves via node_modules but is declared in no manifest", async () => {
    const { repoRoot, srcDir, packageManifestPath } = makeFixtureRepo();
    try {
      writeFileSync(join(srcDir, "leak.ts"), `${IMPORT_WORD} "leak-pkg";\n`, "utf8");
      const pkgDir = join(repoRoot, "node_modules", "leak-pkg");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "leak-pkg", version: "0.0.0" }), "utf8");
      // packageManifestPath (written by makeFixtureRepo) declares nothing —
      // "leak-pkg" is present on disk but named in no manifest anywhere.

      const report = await checkImportBoundary({
        label: "fixture",
        srcDir,
        repoRoot,
        packageManifestPath,
        rootManifestPath: packageManifestPath,
        tsconfigPaths: [],
      });

      expect(report.bareViolations.some((v) => v.includes("leak-pkg"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // F3 — the quote-character class excluded backticks, so a backtick-quoted
  // require call escaped the checker entirely: zero specifiers were even
  // extracted from the line, let alone resolved and rejected.
  it("F3: matches a backtick-quoted require(...) specifier and rejects it when it escapes the repo", async () => {
    const { repoRoot, srcDir, packageManifestPath } = makeFixtureRepo();
    try {
      writeFileSync(
        join(srcDir, "leak-backtick.ts"),
        `${REQUIRE_WORD}(${BACKTICK}${OUTSIDE_SPECIFIER}${BACKTICK});\n`,
        "utf8",
      );

      const report = await checkImportBoundary({
        label: "fixture",
        srcDir,
        repoRoot,
        packageManifestPath,
        rootManifestPath: packageManifestPath,
        tsconfigPaths: [],
      });

      expect(report.relativeViolations.length).toBeGreaterThan(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
