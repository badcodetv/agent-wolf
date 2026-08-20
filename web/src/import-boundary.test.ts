import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria: "web/ imports
// nothing from agent-orange — enforced by a test that fails if any import
// specifier resolves outside the repo." This walks every source file under
// web/src, resolves every relative import specifier, and fails if any of
// them would resolve outside this repository (agent-wolf) — in particular
// outside web/ itself, since web/ has no legitimate reason to reach up into
// a sibling package, let alone a sibling repo.

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const IMPORT_RE = /(?:import|export)(?:[^'"]*from)?\s*["']([^"']+)["']/g;

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(extname(full))) {
      files.push(full);
    }
  }
  return files;
}

function relativeImportSpecifiers(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of src.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("web/ import boundary", () => {
  it("resolves every relative import inside the repository", () => {
    const files = collectSourceFiles(join(webRoot, "src"));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of relativeImportSpecifiers(file)) {
        const resolved = resolve(dirname(file), specifier);
        if (!resolved.startsWith(repoRoot)) {
          violations.push(`${file} imports "${specifier}" -> resolves outside the repo: ${resolved}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("never mentions agent-orange in a source import or bare specifier", () => {
    const files = collectSourceFiles(join(webRoot, "src"));
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(IMPORT_RE)) {
        const specifier = match[1] ?? "";
        if (specifier.toLowerCase().includes("agent-orange")) {
          violations.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
