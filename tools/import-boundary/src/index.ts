/**
 * The ONE import-boundary checker for agent-wolf. `web/` and `api/` are both
 * held to "imports nothing from agent-orange" (design/2026-08-20-agent-wolf.md,
 * W1 acceptance criteria, agent-orange repo) and both consume this module —
 * do not fork a second implementation per package.
 *
 * Graded surface, exactly as the rewritten W1 criterion enumerates it:
 *
 *   - Files scanned: every file under a package's own src dir with an
 *     extension in .ts .tsx .js .jsx .mjs .cjs — every extension Vite +
 *     @vitejs/plugin-react resolves — PLUS any `rootConfigFiles` the
 *     caller names (e.g. web/vite.config.ts, api/vitest.config.ts): a
 *     package's own root config sits beside srcDir, not inside it, and is
 *     just as capable of importing outside the repo (W1 round-4 escalation
 *     F1 — these were unscanned before this field existed).
 *   - Specifier forms: static import/export...from, dynamic import(...),
 *     require(...), import type, side-effect import "...". Any of these
 *     may be single-, double- or backtick-quoted (F3); a backtick literal
 *     containing "${" is a computed expression, not a static path, and is
 *     deliberately left unmatched — a documented plan gap, not this
 *     checker's job to solve.
 *   - Specifier kinds: relative (./ ../), absolute (/...), bare
 *     (react, @mui/material) — a bare specifier is allowed only if
 *     DECLARED in a package.json dependencies/devDependencies, this
 *     package's own or the workspace root's (F2 — mere resolvability via
 *     node_modules is not sufficient; a package hoisted in by someone
 *     else's dependency but declared nowhere still fails). Each kind is
 *     resolved and boundary-checked differently — see the three checker
 *     functions below.
 *   - Config escape routes: a Vite `resolve.alias` target, and a tsconfig
 *     `compilerOptions.paths` target in either of a package's own tsconfig
 *     and the shared root tsconfig.base.json.
 *   - Manifest escape route: a `file:`/`link:`/`portal:` dependency in a
 *     package's own package.json or the root package.json.
 *
 * Every containment check is realpath + path-segment aware
 * (`isPathInside`), never a raw string prefix — `/repo-evil` must not count
 * as inside `/repo`.
 */
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Every extension Vite + @vitejs/plugin-react will resolve and compile. */
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Matches, across the specifier forms the criterion names (module specifier
// elided from this comment block so it does not itself look like an import
// to the regex it documents):
//   import x from SPEC; import SPEC; export * from SPEC; import type ...   (static forms)
//   import(SPEC)                                                          (dynamic import)
//   require(SPEC)                                                         (CJS interop)
// The quote class includes backticks (F3, round-4 escalation): a plain
// backtick-quoted specifier with no interpolation — e.g. require(`../x`) —
// is a real, literal specifier and must be caught exactly like a
// single/double-quoted one. A specifier containing "${" is a *computed*
// template (an actual expression, not a literal path) and is filtered back
// out in allImportSpecifiers below — that case is a documented plan gap
// (W1 Notes), not something this fix widens scope to solve.
const IMPORT_SPECIFIER_PATTERNS = [
  /(?:import|export)(?:[^'"`()]*from)?\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
];

/**
 * A path-segment-aware containment check. `startsWith` alone is unsafe:
 * a sibling directory that merely shares a string prefix with `parent`
 * (e.g. "/repo-evil" vs "/repo") would false-pass. `relative()` gives the
 * correct answer: outside iff the relative path climbs out (starts with
 * "..") or is a wholly separate absolute root.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves a path to its realpath if it exists on disk; returns it as-is otherwise (a dangling reference is still checked for containment by its literal target). */
function realOrLiteral(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

export function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
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

/**
 * Strip `//` and block comments from TypeScript/JavaScript source before
 * scanning it for import specifiers.
 *
 * Without this the patterns below happily match *prose*. A real example,
 * found when W1b's checker met W7's `api/src/config.ts` at merge: the
 * comment
 *
 *     a shell `export` in X1's `run.sh`
 *
 * matches pattern 1 as `export` + the backtick that closes it + " in X1" +
 * the apostrophe in `X1's` — manufacturing a bare specifier `" in X1"` that
 * resolves to nothing and fails the boundary. Neither branch failed alone;
 * only the merge produced it (**R85**).
 *
 * The `[^:]` guard on the line-comment arm keeps `"https://…"` intact, the
 * same guard `stripJsonComments` uses.
 */
function stripSourceComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function allImportSpecifiers(filePath: string): string[] {
  const src = stripSourceComments(readFileSync(filePath, "utf8"));
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of src.matchAll(pattern)) {
      // "${" means the backtick literal is computed, not a static path —
      // out of scope (a documented plan gap, W1 Notes), and left unmatched
      // exactly as it was before backticks joined the quote class.
      if (match[1] && !match[1].includes("${")) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

/** Package name portion of a bare specifier: "@scope/pkg/sub/path" -> "@scope/pkg"; "pkg/sub/path" -> "pkg". */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
}

/**
 * Mirrors (a simplified form of) Node's own node_modules resolution: walk
 * from `startDir` up through every ancestor directory looking for
 * `<ancestor>/node_modules/<pkgName>`. Real escapes (a `file:`/`link:`
 * install, or a package hoisted to a node_modules directory above the repo
 * root) can only be caught by following the exact algorithm Node itself
 * uses, then realpath-ing the result to see where it *actually* lives once
 * symlinks are followed.
 *
 * `pkgName` must be non-empty — the caller (the bare-specifier check) is
 * responsible for routing absolute specifiers (whose naive "package name"
 * is the empty string, because `"/x/y".split("/")` has an empty first
 * segment) to the absolute-specifier check instead of here. Resolving an
 * empty name would silently match `<ancestor>/node_modules` itself, which
 * always exists once installed — exactly the hole the rewritten criterion
 * names.
 */
export function resolvePackageDir(pkgName: string, startDir: string): string | undefined {
  if (pkgName === "") return undefined;
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", pkgName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

/** Every package name a manifest declares, dependency or dev dependency. */
export function declaredDependencyNames(manifestPath: string): Set<string> {
  const manifest = readManifest(manifestPath);
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

/** Strip // and /* *\/ comments so a tsconfig's JSONC can go through JSON.parse. Good enough for this repo's deliberately simple tsconfigs. */
function stripJsonComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every filesystem target named by a tsconfig's `compilerOptions.paths`
 * (resolved against baseUrl, wildcard segment stripped), as absolute paths.
 * A `paths` entry is exactly as capable of aliasing outside the repo as a
 * Vite `resolve.alias` — this is the tsconfig-side half of the same escape.
 */
export function tsconfigPathsTargets(tsconfigPath: string): string[] {
  if (!existsSync(tsconfigPath)) return [];
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    config = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8")));
  } catch {
    return []; // malformed tsconfig is a build-time problem, not this checker's
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

/**
 * Every filesystem target named by a Vite config's `resolve.alias`, as
 * absolute paths. Loaded by dynamic import rather than by regex, so an
 * alias expressed any of Vite's supported shapes — a plain object, an
 * array of {find, replacement}, or a computed value — is still caught
 * rather than only the literal-string-object shape a regex would
 * special-case. Returns `[]` when `viteConfigPath` is undefined or the file
 * does not exist (api/ has no Vite config at all).
 */
export async function viteAliasTargets(viteConfigPath: string | undefined): Promise<string[]> {
  if (!viteConfigPath || !existsSync(viteConfigPath)) return [];
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

export interface ImportBoundaryConfig {
  /** Human-readable label for error messages, e.g. "web/" or "api/". */
  label: string;
  /** The directory to walk for source files, e.g. `<repoRoot>/web/src`. */
  srcDir: string;
  /** The repo checkout root — the boundary every check resolves against. */
  repoRoot: string;
  /** This package's own package.json (dependency + file:/link:/portal: checks). */
  packageManifestPath: string;
  /** The workspace root package.json (same two checks, repo-wide). */
  rootManifestPath: string;
  /** This package's own tsconfig(s) whose `compilerOptions.paths` are checked. Include the shared base config too if it might carry `paths`. */
  tsconfigPaths: string[];
  /** This package's own vite.config.ts, if it has one. */
  viteConfigPath?: string;
  /**
   * Root config files sitting BESIDE srcDir rather than inside it — e.g.
   * web/vite.config.ts, api/vitest.config.ts — that must be scanned for
   * import specifiers exactly like a src/ file. Round-4 escalation F1:
   * checkImportBoundary previously walked only srcDir, so these files
   * could import anything unexamined. A path that does not exist is
   * skipped rather than erroring (a package with no such file, e.g. api/
   * had no vite.config.ts before this fix either).
   */
  rootConfigFiles?: string[];
}

export interface ImportBoundaryReport {
  files: string[];
  relativeViolations: string[];
  absoluteViolations: string[];
  bareViolations: string[];
  viteAliasViolations: string[];
  tsconfigPathsViolations: string[];
  manifestEscapeViolations: string[];
  agentOrangeMentionViolations: string[];
}

/**
 * Runs every check the W1 criterion enumerates against one package and
 * returns per-category violation lists (each `[]` when clean). Callers
 * (the per-package test suites) assert each category is empty, so a
 * failure names exactly which check tripped.
 */
export async function checkImportBoundary(config: ImportBoundaryConfig): Promise<ImportBoundaryReport> {
  const { srcDir, repoRoot, packageManifestPath, rootManifestPath, tsconfigPaths, viteConfigPath, rootConfigFiles } =
    config;
  // Root config files (F1) are scanned alongside srcDir, not instead of it:
  // the same specifier-form checks below (relative/absolute/bare,
  // agent-orange mention) run over both, since a config file is exactly as
  // capable of importing outside the repo as a source file is.
  const files = [...collectSourceFiles(srcDir), ...(rootConfigFiles ?? []).filter((f) => existsSync(f))];

  const declared = new Set<string>([
    ...declaredDependencyNames(packageManifestPath),
    ...(existsSync(rootManifestPath) ? declaredDependencyNames(rootManifestPath) : []),
  ]);

  const relativeViolations: string[] = [];
  const absoluteViolations: string[] = [];
  const bareViolations: string[] = [];
  const agentOrangeMentionViolations: string[] = [];

  for (const file of files) {
    for (const specifier of allImportSpecifiers(file)) {
      if (specifier.toLowerCase().includes("agent-orange")) {
        agentOrangeMentionViolations.push(`${file} imports "${specifier}"`);
      }

      if (specifier.startsWith(".")) {
        // Relative — resolve and assert the realpath is inside the repo,
        // by path segment, not by string prefix.
        const resolved = resolve(dirname(file), specifier);
        const real = realOrLiteral(resolved);
        if (!isPathInside(real, repoRoot)) {
          relativeViolations.push(`${file} imports "${specifier}" -> resolves outside the repo: ${real}`);
        }
        continue;
      }

      if (isBuiltin(specifier)) continue; // node: builtins have no filesystem target

      if (isAbsolute(specifier)) {
        // Absolute — must NOT fall through to the bare-specifier branch,
        // where an empty package name (an absolute specifier's naive
        // "package name" via packageNameOf, since "/x".split("/")[0] is "")
        // would resolve to an existing node_modules dir and pass unexamined
        // regardless of what the absolute path actually names. This is the
        // exact hole the rewritten criterion closes.
        const real = realOrLiteral(specifier);
        if (!isPathInside(real, repoRoot)) {
          absoluteViolations.push(`${file} imports "${specifier}" -> resolves outside the repo: ${real}`);
        }
        continue;
      }

      // Bare — allowed only if DECLARED in a manifest (dependencies or
      // devDependencies, this package's own or the workspace root's).
      // Round-4 escalation F2: resolvability via node_modules is not the
      // same thing as declaration — a package hoisted into node_modules as
      // someone else's transitive dependency, but named in no manifest,
      // must still fail. So declaration is checked unconditionally, before
      // resolution is even attempted; a resolved-but-undeclared specifier
      // is exactly the case this closes. A declared-but-not-installed
      // specifier still passes (nothing to resolve, nothing to check).
      const pkgName = packageNameOf(specifier);
      if (!declared.has(pkgName)) {
        bareViolations.push(
          `${file} imports "${specifier}" -> package "${pkgName}" is not declared in a package.json (dependencies/devDependencies)`,
        );
        continue;
      }
      const dir = resolvePackageDir(pkgName, dirname(file));
      if (!dir) continue; // declared but not installed — passes
      const real = realpathSync(dir);
      if (!isPathInside(real, repoRoot)) {
        bareViolations.push(
          `${file} imports "${specifier}" -> node_modules entry "${dir}" resolves (via realpath) outside the repo: ${real}`,
        );
      }
    }
  }

  const viteAliasViolations: string[] = [];
  for (const target of await viteAliasTargets(viteConfigPath)) {
    const real = realOrLiteral(target);
    if (!isPathInside(real, repoRoot)) {
      viteAliasViolations.push(`vite.config.ts resolve.alias target resolves outside the repo: ${target} -> ${real}`);
    }
  }

  const tsconfigPathsViolations: string[] = [];
  for (const tsconfigPath of tsconfigPaths) {
    for (const target of tsconfigPathsTargets(tsconfigPath)) {
      const real = realOrLiteral(target);
      if (!isPathInside(real, repoRoot)) {
        tsconfigPathsViolations.push(
          `${tsconfigPath} compilerOptions.paths target resolves outside the repo: ${target} -> ${real}`,
        );
      }
    }
  }

  const manifestEscapeViolations: string[] = [];
  for (const manifestPath of [packageManifestPath, rootManifestPath]) {
    if (!existsSync(manifestPath)) continue;
    const manifest = readManifest(manifestPath);
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const manifestDir = dirname(manifestPath);
    for (const [name, version] of Object.entries(deps)) {
      const match = /^(file|link|portal):(.+)$/.exec(version ?? "");
      if (!match) continue;
      const targetSpec = match[2] ?? "";
      const target = resolve(manifestDir, targetSpec);
      const real = realOrLiteral(target);
      if (!isPathInside(real, repoRoot)) {
        manifestEscapeViolations.push(
          `${manifestPath} declares "${name}": "${version}" -> resolves outside the repo: ${real}`,
        );
      }
    }
  }

  return {
    files,
    relativeViolations,
    absoluteViolations,
    bareViolations,
    viteAliasViolations,
    tsconfigPathsViolations,
    manifestEscapeViolations,
    agentOrangeMentionViolations,
  };
}
