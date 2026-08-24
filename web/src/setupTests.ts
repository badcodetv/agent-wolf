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
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

declare module "vitest" {
  // `T = any` matches vitest's own declaration exactly; anything else is
  // TS2428 "All declarations of 'Assertion' must have identical type
  // parameters". jest-dom's own vitest.d.ts writes it the same way.
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
