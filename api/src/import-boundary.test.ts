import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkImportBoundary, collectSourceFiles } from "@wolf/import-boundary";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria: "api/ is now
// held to the same boundary using the same checker — do not write a second
// one." The checker itself lives in tools/import-boundary (see its doc
// comment for the full graded surface); this file only wires api/'s own
// paths and asserts each violation category is empty. api/ has no Vite
// config, so `viteConfigPath` is omitted — checkImportBoundary treats a
// missing config as zero alias targets, not as a pass-by-default.

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, ".."); // api/
const repoRoot = resolve(apiRoot, ".."); // agent-wolf/

async function runCheck() {
  return checkImportBoundary({
    label: "api/",
    srcDir: join(apiRoot, "src"),
    repoRoot,
    packageManifestPath: join(apiRoot, "package.json"),
    rootManifestPath: join(repoRoot, "package.json"),
    tsconfigPaths: [join(apiRoot, "tsconfig.json"), join(repoRoot, "tsconfig.base.json")],
    // F1 (W1 round-4 escalation): api/vitest.config.ts sits beside src/,
    // not inside it, and was never scanned. Naming it here is what closes
    // that hole for the real tree, not just in the fixture regression test.
    rootConfigFiles: [join(apiRoot, "vitest.config.ts")],
  });
}

describe("api/ import boundary", () => {
  it("has source files to check", () => {
    const files = collectSourceFiles(join(apiRoot, "src"));
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

  it("has no vite.config.ts alias targets (api/ has no Vite config)", async () => {
    const report = await runCheck();
    expect(report.viteAliasViolations).toEqual([]);
  });

  it("resolves every tsconfig.json paths target (api/tsconfig.json and tsconfig.base.json) inside the repo", async () => {
    const report = await runCheck();
    expect(report.tsconfigPathsViolations).toEqual([]);
  });

  it("never mentions agent-bob in any import specifier", async () => {
    const report = await runCheck();
    expect(report.agentBobMentionViolations).toEqual([]);
  });

  it("has no file:/link:/portal: dependency resolving outside the repo", async () => {
    const report = await runCheck();
    expect(report.manifestEscapeViolations).toEqual([]);
  });

  // F1 (W1 round-4 escalation): proves api/vitest.config.ts is actually
  // scanned, not just that its imports happen to be clean. If this ever
  // regresses to not-scanned, this is the assertion that catches it.
  it("scans api/vitest.config.ts as part of the boundary", async () => {
    const report = await runCheck();
    expect(report.files).toContain(join(apiRoot, "vitest.config.ts"));
  });
});
