/**
 * Vitest setup for web/. Registers @testing-library/jest-dom's matchers
 * (toBeInTheDocument, toHaveTextContent, toHaveAttribute, …) — the pinned
 * component-test stack for this package, see § "Pinned technology choices" in
 * design/2026-08-20-agent-wolf.md (agent-orange repo).
 *
 * Both halves below are done by hand rather than by the one-line
 * `import "@testing-library/jest-dom/vitest"` the README gives, and the reason
 * is a yarn-1 workspace layout, not taste:
 *
 *   - jest-dom hoists to the REPO ROOT's node_modules, while vitest stays
 *     nested in web/node_modules (api/ has its own copy). The hoisted
 *     dist/vitest.mjs therefore cannot resolve its own `import "vitest"`:
 *     `Error: Cannot find package 'vitest' imported from
 *     <repo>/node_modules/@testing-library/jest-dom/dist/vitest.mjs`.
 *     Importing vitest from HERE resolves, because this file lives under web/.
 *   - The same asymmetry defeats the type side: that entry's
 *     `declare module "vitest"` cannot merge with a vitest it cannot resolve,
 *     so `toBeInTheDocument` stays absent from `Assertion` and `yarn typecheck`
 *     fails while `yarn test` passes. The augmentation below is that file's,
 *     re-stated where the resolution works.
 */
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

/**
 * ⚠️ ADDED BY W13, in a file W28 owns — the one edit this ticket makes here,
 * and it is load-bearing rather than tidiness.
 *
 * `@testing-library/react` auto-registers its own `afterEach(cleanup)` ONLY
 * when it can see a global `afterEach`, i.e. when the runner has
 * `globals: true`. `web/vite.config.ts` deliberately does not set that, so
 * without this line NOTHING unmounts between tests: every render stacks into
 * the same `document.body`, and the second test in any file that renders the
 * same component fails with "Found multiple elements by: [data-testid=…]" —
 * an error that reads as a bug in the component under test rather than as a
 * missing teardown.
 *
 * The alternative (a `cleanup()` in every component test file) is the same
 * line written eight times, and the failure mode of forgetting one is that
 * confusing error in an unrelated file. W28's two trust suites already pass
 * either way, because each renders into its own `render()` result and asserts
 * through it; W13's first table test over six states is what surfaced this.
 */
afterEach(() => {
  cleanup();
});

declare module "vitest" {
  // `T = any` matches vitest's own declaration exactly; anything else is
  // TS2428 "All declarations of 'Assertion' must have identical type
  // parameters". jest-dom's own vitest.d.ts writes it the same way.
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
