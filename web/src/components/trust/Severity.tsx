/**
 * Channel S of the trust language — `design/2026-08-24-agent-wolf-ui.md` § 2
 * "Channel S — severity. Mostly absent. Escalates." (agent-bob repo).
 *
 * A **changing state**: how much should you trust this *right now*?
 *
 *   none      Nothing rendered. This is the overwhelming majority.
 *   degraded  A `warning`-toned inline marker PLUS a sentence naming the
 *             cause. Never a bare icon.
 *   attacked  A full-width MUI `Alert severity="error"`, unmissable, naming
 *             the writer and the memory id.
 *
 * 🔴 `Severity` has **no default cause and refuses to render without one**. A
 * bare marker that does not say what happened is how a spec mistake stays
 * invisible for three weeks — so a missing cause is a programming error, and
 * it is treated as one: it throws in development (where a developer sees it)
 * and renders nothing in production (where a half-built alert would be worse
 * than none, and an uncaught throw would take the page down).
 *
 * 🔴 `error` red appears NOWHERE in this product but `attacked`. That is why
 * a `tripped` condition is the accent: a trip is the system working correctly
 * and consequentially, an attack is the system being lied to, and sharing a
 * colour between them would blunt both. `Severity.test.tsx` renders every
 * other trust state and asserts none of them computes to the error colour.
 */
import { Alert, Box, Typography } from "@mui/material";
import { SEVERITY_GLYPHS } from "../../theme.js";

export type SeverityLevel = "none" | "degraded" | "attacked";

export interface SeverityProps {
  level: SeverityLevel;
  /**
   * The sentence naming what happened — mandatory for `degraded` and
   * `attacked`. There is deliberately no default: see the file header.
   *
   * e.g. `"no update since 12 Aug — FRED restated DGS10"`,
   *      `"forged row — researcher-9c1b wrote memory mem_7f3a"`.
   */
  cause?: string;
}

/**
 * True in a production bundle, false under `vite dev` and under vitest
 * (whose MODE is "test").
 *
 * Read at call time, not at module load, so a test can flip it with
 * `vi.stubEnv`. `MODE` is checked first because it is a string and therefore
 * stubbable in every vitest version; `PROD` is the belt to its braces.
 */
function isProductionBuild(): boolean {
  const env = import.meta.env as { MODE?: string; PROD?: boolean };
  return env.MODE === "production" || env.PROD === true;
}

export function hasCause(cause: string | undefined): boolean {
  return typeof cause === "string" && cause.trim().length > 0;
}

export default function Severity({ level, cause }: SeverityProps) {
  if (level === "none") return null;

  if (!hasCause(cause)) {
    if (!isProductionBuild()) {
      throw new Error(
        `<Severity level="${level}"> was rendered without a cause. Every severity carries a sentence naming what happened — a bare marker is how a spec mistake stays invisible for three weeks (agent-wolf UI design § 2, "Channel S").`,
      );
    }
    return null;
  }

  const sentence = (cause ?? "").trim();

  if (level === "attacked") {
    return (
      <Alert
        data-testid="severity"
        data-severity="attacked"
        severity="error"
        variant="outlined"
        // § 2b: never colour-alone. The glyph replaces MUI's default icon so
        // the state reads in a greyscale screenshot as well as in colour.
        icon={
          <Box component="span" aria-hidden sx={{ color: "error.main", fontSize: 16, lineHeight: 1 }}>
            {SEVERITY_GLYPHS.attacked}
          </Box>
        }
        sx={{ width: "100%" }}
      >
        {sentence}
      </Alert>
    );
  }

  return (
    <Box
      data-testid="severity"
      data-severity="degraded"
      role="status"
      sx={{ display: "flex", alignItems: "baseline", gap: 1, color: "warning.main" }}
    >
      <Box component="span" aria-hidden sx={{ fontSize: 13, lineHeight: 1 }}>
        {SEVERITY_GLYPHS.degraded}
      </Box>
      <Typography component="span" sx={{ fontSize: 13, color: "warning.main" }}>
        {sentence}
      </Typography>
    </Box>
  );
}
