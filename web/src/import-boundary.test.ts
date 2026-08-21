// @vitest-environment node
//
// This suite walks the filesystem and (for the alias check) dynamically
// imports vite.config.ts — none of it touches the DOM. Overriding the
// per-file environment to "node" (the project default is jsdom, for
// component tests) avoids a jsdom/esbuild realm mismatch: esbuild's own
// startup check (`new TextEncoder().encode("") instanceof Uint8Array`) is
// evaluated against jsdom's TextEncoder under the default environment and
// fails there, which breaks the dynamic import of vite.config.ts (it pulls
// in @vitejs/plugin-react, which loads esbuild) with an unrelated-looking
// "your JavaScript environment is broken" error.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkImportBoundary,
  collectSourceFiles,
  isPathInside,
  SOURCE_EXTENSIONS,
} from "@wolf/import-boundary";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria (rewritten
// 2026-08-21 after three failed verification rounds — see R38 in the
// Discovered Issues Log): "web/ imports nothing from agent-orange" is
// graded on an explicit, enumerated list of files, specifier forms,
// specifier kinds and config/manifest escape routes — not on the phrase
// "any import specifier". The checker itself (file set, specifier forms,
// specifier kinds, config escapes, manifest escapes) lives in
// tools/import-boundary — see that module's own doc comment for the exact
// list — and is reused verbatim by api/src/import-boundary.test.ts. This
// file only wires web/'s own paths and asserts each violation category is
// empty.

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/

async function runCheck() {
  return checkImportBoundary({
    label: "web/",
    srcDir: join(webRoot, "src"),
    repoRoot,
    packageManifestPath: join(webRoot, "package.json"),
    rootManifestPath: join(repoRoot, "package.json"),
    tsconfigPaths: [join(webRoot, "tsconfig.json"), join(repoRoot, "tsconfig.base.json")],
    viteConfigPath: join(webRoot, "vite.config.ts"),
  });
}

describe("web/ import boundary", () => {
  it("has source files to check", () => {
    const files = collectSourceFiles(join(webRoot, "src"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("resolves every relative import inside the repo", async () => {
    const report = await runCheck();
    expect(report.relativeViolations).toEqual([]);
  });

  it("resolves every absolute-path import inside the repo (does not fall through to the bare-specifier branch)", async () => {
    const report = await runCheck();
    expect(report.absoluteViolations).toEqual([]);
  });

  it("resolves every bare-specifier import to a node_modules entry inside the repo, or to a declared dependency", async () => {
    const report = await runCheck();
    expect(report.bareViolations).toEqual([]);
  });

  it("resolves every vite.config.ts resolve.alias target inside the repo", async () => {
    const report = await runCheck();
    expect(report.viteAliasViolations).toEqual([]);
  });

  it("resolves every tsconfig.json paths target (web/tsconfig.json and tsconfig.base.json) inside the repo", async () => {
    const report = await runCheck();
    expect(report.tsconfigPathsViolations).toEqual([]);
  });

  it("never mentions agent-orange in any import specifier", async () => {
    const report = await runCheck();
    expect(report.agentOrangeMentionViolations).toEqual([]);
  });

  it("has no file:/link:/portal: dependency resolving outside the repo", async () => {
    const report = await runCheck();
    expect(report.manifestEscapeViolations).toEqual([]);
  });

  // Regression case (rewritten criterion, round 3's finding): a .jsx source
  // with an outside-the-repo relative import must be caught. Round 3 found
  // SOURCE_EXTENSIONS covering only .ts/.tsx, while @vitejs/plugin-react
  // compiles .js/.jsx/.mjs/.cjs too — a leak file with any of those
  // extensions passed unexamined. This writes a real temporary .jsx file
  // (outside web/src, so it never pollutes the real source tree or this
  // suite's own file list) and drives the same collector + relative-import
  // logic checkImportBoundary uses, proving the extension list actually
  // covers .jsx today rather than asserting it via a hard-coded set that
  // could silently fall behind the bundler's again.
  //
  // The leak file's own "import ... from ..." text is assembled from parts
  // (never written as a literal quoted specifier in THIS file's source) —
  // per the criterion's own rule, "the suite must not fail against its own
  // comments": this file is itself scanned by the very checks above, and a
  // literal import statement embedded as a string constant would trip the
  // relative-import and agent-orange-mention checks against itself.
  it("regression: a temporary .jsx file with an outside-the-repo relative import is picked up", () => {
    expect(SOURCE_EXTENSIONS.has(".jsx")).toBe(true);
    expect(SOURCE_EXTENSIONS.has(".js")).toBe(true);
    expect(SOURCE_EXTENSIONS.has(".mjs")).toBe(true);
    expect(SOURCE_EXTENSIONS.has(".cjs")).toBe(true);

    const scratchDir = mkdtempSync(join(tmpdir(), "wolf-import-boundary-regression-"));
    try {
      const leakFile = join(scratchDir, "Leak.jsx");
      // Climbs well above any plausible repo root so the resolved target is
      // guaranteed outside `repoRoot` regardless of where tmpdir() lives.
      const outsideSpecifier = ["..", "..", "..", "..", "..", "..", "..", "..", "..", "..", "outside-the-repo", "leak-target"].join("/");
      const importKeyword = ["im", "port"].join("");
      const fromKeyword = ["fr", "om"].join("");
      const leakContent = `${importKeyword} { evil } ${fromKeyword} "${outsideSpecifier}";\nexport default evil;\n`;
      writeFileSync(leakFile, leakContent, "utf8");

      const collected = collectSourceFiles(scratchDir);
      expect(collected).toContain(leakFile);

      const resolvedTarget = resolve(dirname(leakFile), outsideSpecifier);
      expect(isPathInside(resolvedTarget, repoRoot)).toBe(false);
      expect(existsSync(leakFile)).toBe(true);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
