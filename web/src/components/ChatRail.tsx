/**
 * The rail — UI design § 5 "The rail" (agent-orange repo).
 *
 * The rail is the CONTAINER; `OrangeChatFrame` is what fills it. Splitting
 * them is the point: the frame then has a known height (`100%` of a rail whose
 * height is the viewport's) without anyone measuring a cross-origin document,
 * which is not possible from outside it.
 *
 *   - `position: sticky; top: 0; height: 100vh`
 *   - width `clamp(340px, 28vw, 460px)`
 *   - collapsible to a thin edge, with a restore control
 *   - below the `md` breakpoint it becomes a TAB above the left column's
 *     content — never a fixed-height box in the middle of a scrolling document
 *
 * W14 renders the detail page's left column beside this component and does not
 * re-implement it: the rail is shared, and `hypothesisId` is all it needs.
 *
 * There is no icon import here on purpose. The collapse affordance is the
 * `⟨⟩` glyph § 5's own sketch draws, so W13 adds no dependency beyond React
 * Router — and the barrel-vs-deep-import hazard (R136: `@mui/icons-material`
 * is 10 617 modules through the barrel) never arises.
 */

import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import OrangeChatFrame from "./OrangeChatFrame.js";

/** § 5: "Width `400px` (`clamp(340px, 28vw, 460px)`)". */
export const RAIL_WIDTH = "clamp(340px, 28vw, 460px)";

/** The thin edge a collapsed rail leaves behind, so the restore control stays reachable. */
export const RAIL_COLLAPSED_WIDTH = "44px";

export interface ChatRailProps {
  /** The BARE 8-hex id. */
  hypothesisId: string;
  /** Rendered above the frame; defaults to § 5's own heading. */
  heading?: ReactNode;
}

export default function ChatRail({ hypothesisId, heading = "Conversation" }: ChatRailProps) {
  const theme = useTheme();
  const isNarrow = useMediaQuery(theme.breakpoints.down("md"));
  const [open, setOpen] = useState(true);

  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 1,
        px: 1.5,
        py: 1,
        borderBottom: `1px solid ${theme.palette.divider}`,
      }}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.04em" }}>
        {heading}
      </Typography>
      <Tooltip title={open ? "Collapse the conversation" : "Show the conversation"}>
        <Button
          data-testid="chat-rail-toggle"
          size="small"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-label={open ? "Collapse the conversation" : "Show the conversation"}
          sx={{ minWidth: 0, px: 1, fontSize: 13, lineHeight: 1 }}
        >
          {open ? "⟨⟩" : "⟩⟨"}
        </Button>
      </Tooltip>
    </Box>
  );

  if (isNarrow) {
    // A TAB, not a box: a disclosure control in the flow, and the frame only
    // when it is open. Height is a viewport fraction, never a pixel count.
    return (
      <Box data-testid="chat-rail" data-rail-mode="tab" sx={{ width: "100%", mb: 2 }}>
        {header}
        {open ? (
          <Box sx={{ height: "70vh" }}>
            <OrangeChatFrame hypothesisId={hypothesisId} />
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      data-testid="chat-rail"
      data-rail-mode="rail"
      data-rail-open={open ? "true" : "false"}
      sx={{
        position: "sticky",
        top: 0,
        // The viewport's height, which is what makes the frame's `100%` mean
        // something. Not a pixel count, and not a measurement.
        height: "100vh",
        flex: "0 0 auto",
        width: open ? RAIL_WIDTH : RAIL_COLLAPSED_WIDTH,
        display: "flex",
        flexDirection: "column",
        borderLeft: `1px solid ${theme.palette.divider}`,
        backgroundColor: "background.paper",
        overflow: "hidden",
      }}
    >
      {open ? (
        header
      ) : (
        <Tooltip title="Show the conversation">
          <Button
            data-testid="chat-rail-toggle"
            size="small"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-label="Show the conversation"
            sx={{ minWidth: 0, px: 1, py: 2, fontSize: 13, writingMode: "vertical-rl" }}
          >
            ⟩⟨
          </Button>
        </Tooltip>
      )}
      {open ? (
        // `flex: 1` gives the frame the rest of the rail. The frame itself
        // carries `height: 100%` and no pixel height at all.
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <OrangeChatFrame hypothesisId={hypothesisId} />
        </Box>
      ) : null}
    </Box>
  );
}
