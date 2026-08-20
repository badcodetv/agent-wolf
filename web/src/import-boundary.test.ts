import { describe, expect, it } from "vitest";
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria: "web/ imports
// nothing from agent-orange — enforced by a test that fails if any import
// specifier resolves outside the repo." This walks every source file under
// web/src plus both package.json manifests, and fails if ANY way of naming a
// module — a relative import, a dynamic import()/require(), a bare
// specifier resolved through node_modules, or a file:/link:/portal:
// dependency — resolves outside this repository (agent-wolf). Fix-round-1
// findings this version closes: dynamic import()/require() were unmatched;
// bare specifiers (a `file:` dependency installed as e.g. "@agentkit/web")
// were never resolved at all; and `startsWith(repoRoot)` is not a safe
// boundary check (a sibling directory like "agent-wolf-old" shares that
// prefix as a string without being inside the repo).

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Matches, across three call shapes:
//   import x from "spec"; import "spec"; export * from "spec";
//   import("spec")                                    (dynamic import)
//   require("spec")                                   (CJS interop)
const IMPORT_SPECIFIER_PATTERNS = [
  /(?:import|export)(?:[^'"()]*from)?\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

// A path-segment-aware containment check. `startsWith` alone is unsafe:
// resolve(repoRoot, "..", "agent-wolf-old") string-starts-with repoRoot's
// sibling prefix in some layouts, and more generally any directory that
// merely shares a string prefix (not a path-segment prefix) with `parent`
// would false-pass. `relative()` gives the correct answer: outside iff the
// relative path climbs out (starts with "..") or is a separate absolute
// root entirely (different drive on Windows).
function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
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

function allImportSpecifiers(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of src.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

// Package name portion of a bare specifier: "@scope/pkg/sub/path" ->
// "@scope/pkg"; "pkg/sub/path" -> "pkg".
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
}

// Mirrors (a simplified form of) Node's own node_modules resolution: walk
// from `startDir` up through every ancestor directory — not stopping at
// webRoot or repoRoot — looking for `<ancestor>/node_modules/<pkgName>`.
// Real escapes (a `file:`/`link:` install, or a package hoisted to a
// node_modules directory above the repo root) can only be caught by
// following the exact algorithm Node itself uses, then realpath-ing the
// result to see where it *actually* lives once symlinks are followed.
function resolvePackageDir(pkgName: string, startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", pkgName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

describe("web/ import boundary", () => {
  const files = collectSourceFiles(join(webRoot, "src"));

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("resolves every relative import inside web/", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of allImportSpecifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = resolve(dirname(file), specifier);
        if (!isPathInside(resolved, webRoot)) {
          violations.push(`${file} imports "${specifier}" -> resolves outside web/: ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves every bare-specifier import to a node_modules entry inside the repo", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of allImportSpecifiers(file)) {
        if (specifier.startsWith(".")) continue; // relative, checked above
        if (isBuiltin(specifier)) continue; // node: builtins have no node_modules entry

        const pkgName = packageNameOf(specifier);
        const dir = resolvePackageDir(pkgName, dirname(file));
        if (!dir) {
          // Nothing on disk resolves this specifier at all — not an escape
          // (there is nowhere for it to escape to), but also not silently
          // ignorable: an uninstalled or misspelled import is a real bug,
          // just not this test's bug to report.
          continue;
        }
        const real = realpathSync(dir);
        if (!isPathInside(real, repoRoot)) {
          violations.push(
            `${file} imports "${specifier}" -> node_modules entry "${dir}" resolves (via realpath) outside the repo: ${real}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never mentions agent-orange in any import specifier", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of allImportSpecifiers(file)) {
        if (specifier.toLowerCase().includes("agent-orange")) {
          violations.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no file:/link:/portal: dependency resolving outside the repo", () => {
    const manifests = [join(webRoot, "package.json"), join(repoRoot, "package.json")];
    const violations: string[] = [];

    for (const manifestPath of manifests) {
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      const manifestDir = dirname(manifestPath);

      for (const [name, version] of Object.entries(deps)) {
        const match = /^(file|link|portal):(.+)$/.exec(version);
        if (!match) continue;
        const targetSpec = match[2] ?? "";
        const target = resolve(manifestDir, targetSpec);
        const real = existsSync(target) ? realpathSync(target) : target;
        if (!isPathInside(real, repoRoot)) {
          violations.push(
            `${manifestPath} declares "${name}": "${version}" -> resolves outside the repo: ${real}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
