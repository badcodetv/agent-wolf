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
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// design/2026-08-20-agent-wolf.md, W1 acceptance criteria: "web/ imports
// nothing from agent-orange — enforced by a test that fails if any import
// specifier resolves outside the repo." This walks every source file under
// web/src plus both package.json manifests, and fails if ANY way of naming a
// module — a relative import, a dynamic import()/require(), a bare
// specifier resolved through node_modules, a file:/link:/portal:
// dependency, a Vite `resolve.alias` target, or a tsconfig `paths` target —
// resolves outside this repository (agent-wolf). Fix-round-1 findings this
// version closes: dynamic import()/require() were unmatched; bare
// specifiers (a `file:` dependency installed as e.g. "@agentkit/web") were
// never resolved at all; and `startsWith(repoRoot)` is not a safe boundary
// check (a sibling directory like "agent-wolf-old" shares that prefix as a
// string without being inside the repo). Fix-round-2 finding this version
// closes: a bare specifier that resolves through a Vite `resolve.alias` (or
// a tsconfig `paths` entry) has no node_modules entry at all, so it fell
// into the "nothing resolves it, not this test's problem" branch and passed
// unexamined — which is exactly the route the plan names for how
// examples/web consumes Orange's UI (`examples/web/vite.config.ts:21-38`).
// Two changes close it: `vite.config.ts`'s `resolve.alias` and
// `tsconfig.json`'s `compilerOptions.paths` are now read and every target
// they name is boundary-checked; and an unresolvable bare specifier is now a
// violation unless its package name is declared in web/package.json's
// dependencies/devDependencies (so a specifier that is neither a real
// package nor a builtin can no longer pass unexamined).

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, ".."); // web/
const repoRoot = resolve(webRoot, ".."); // agent-wolf/
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Matches, across three call shapes (module specifier elided below so this
// comment block does not itself look like an import to the regex it is
// documenting):
//   import x from SPEC; import SPEC; export * from SPEC   (static forms)
//   import(SPEC)                                          (dynamic import)
//   require(SPEC)                                         (CJS interop)
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

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

// Every package name web/package.json declares, dependency or dev
// dependency. A bare specifier naming one of these is allowed to fail
// node_modules resolution (e.g. a fresh checkout before install) without
// being treated as an escape; anything else that resolves to nothing on
// disk is a real, unexplained bare specifier and must be flagged.
function declaredDependencyNames(): Set<string> {
  const manifest = readManifest(join(webRoot, "package.json"));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

// Strip // and /* */ comments so tsconfig's JSONC can go through
// JSON.parse. Good enough for this file's own tsconfig, which is
// deliberately simple; if it ever grows a `//` or `/*` inside a string
// value this would need a real JSONC parser, but it does not today.
function stripJsonComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Every filesystem target named by web/tsconfig.json's compilerOptions.paths
// (resolved against baseUrl, wildcard segment stripped), as absolute paths.
// A `paths` entry is exactly as capable of aliasing outside the repo as a
// Vite resolve.alias — this is the tsconfig-side half of the same escape.
function tsconfigPathsTargets(tsconfigPath: string): string[] {
  if (!existsSync(tsconfigPath)) return [];
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    config = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8")));
  } catch {
    return []; // malformed tsconfig is a build-time problem, not this test's
  }
  const paths = config.compilerOptions?.paths;
  if (!paths) return [];
  const baseDir = resolve(dirname(tsconfigPath), config.compilerOptions?.baseUrl ?? ".");
  const targets: string[] = [];
  for (const patterns of Object.values(paths)) {
    for (const pattern of patterns) {
      targets.push(resolve(baseDir, pattern.replace(/\*/g, "")));
    }
  }
  return targets;
}

// Every filesystem target named by web/vite.config.ts's resolve.alias, as
// absolute paths. Loaded by dynamic import (this file already runs under
// vitest's own TS-aware module loader, which is what evaluates
// vite.config.ts to run this very suite) rather than by regex, so an alias
// expressed any of Vite's supported shapes — a plain object, an array of
// {find, replacement}, or a computed value — is still caught rather than
// only the literal-string-object shape a regex would special-case.
async function viteAliasTargets(viteConfigPath: string): Promise<string[]> {
  if (!existsSync(viteConfigPath)) return [];
  const mod = (await import(pathToFileURL(viteConfigPath).href)) as {
    default?: { resolve?: { alias?: unknown } };
  };
  const alias = mod.default?.resolve?.alias;
  if (!alias) return [];

  const entries: Array<[string, unknown]> = Array.isArray(alias)
    ? alias.map((a) => [String((a as { find: unknown }).find), (a as { replacement: unknown }).replacement])
    : Object.entries(alias as Record<string, unknown>);

  const targets: string[] = [];
  for (const [, replacement] of entries) {
    if (typeof replacement !== "string") continue;
    targets.push(isAbsolute(replacement) ? replacement : resolve(dirname(viteConfigPath), replacement));
  }
  return targets;
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

  it("resolves every bare-specifier import to a node_modules entry inside the repo, or to a declared dependency", () => {
    const declared = declaredDependencyNames();
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of allImportSpecifiers(file)) {
        if (specifier.startsWith(".")) continue; // relative, checked above
        if (isBuiltin(specifier)) continue; // node: builtins have no node_modules entry

        const pkgName = packageNameOf(specifier);
        const dir = resolvePackageDir(pkgName, dirname(file));
        if (!dir) {
          // Nothing on disk resolves this specifier via node_modules. That is
          // legitimate for a declared-but-not-yet-installed dependency (a
          // clean checkout before `yarn install`), but a specifier naming a
          // package that is neither installed NOR declared is exactly the
          // shape of a bare specifier that only resolves through a bundler
          // alias (Vite resolve.alias / tsconfig paths) — those are
          // boundary-checked directly below, but a specifier is flagged here
          // regardless of whether this suite's alias scan actually catches
          // the particular alias mechanism used, so an unexplained bare
          // specifier can never pass silently.
          if (!declared.has(pkgName)) {
            violations.push(
              `${file} imports "${specifier}" -> package "${pkgName}" is neither present in node_modules nor declared in web/package.json (dependencies/devDependencies)`,
            );
          }
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

  it("resolves every vite.config.ts resolve.alias target inside the repo", async () => {
    const targets = await viteAliasTargets(join(webRoot, "vite.config.ts"));
    const violations: string[] = [];
    for (const target of targets) {
      const real = existsSync(target) ? realpathSync(target) : target;
      if (!isPathInside(real, repoRoot)) {
        violations.push(`vite.config.ts resolve.alias target resolves outside the repo: ${target} -> ${real}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("resolves every tsconfig.json paths target inside the repo", () => {
    // web/tsconfig.json itself, plus the base config it extends — a `paths`
    // entry declared at either level is equally capable of aliasing out.
    const targets = [
      ...tsconfigPathsTargets(join(webRoot, "tsconfig.json")),
      ...tsconfigPathsTargets(join(repoRoot, "tsconfig.base.json")),
    ];
    const violations: string[] = [];
    for (const target of targets) {
      const real = existsSync(target) ? realpathSync(target) : target;
      if (!isPathInside(real, repoRoot)) {
        violations.push(`tsconfig.json paths target resolves outside the repo: ${target} -> ${real}`);
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
