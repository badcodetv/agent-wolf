import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import Archive from "./Archive.js";
import { renderWithProviders, stubFetchRoutes, type FetchRoutes } from "../testUtils.js";
import type { BoardRow } from "../api/types.js";

const BOARD = "GET /api/hypotheses";

function row(over: Partial<BoardRow> & { id: string }): BoardRow {
  return {
    title: `hypothesis ${over.id}`,
    title_truncated: false,
    owner: "kai",
    status: "archived",
    support_score: 0,
    conditions_summary: null,
    updated_at_ms: 1_780_000_000_000,
    headline: null,
    ...over,
  };
}

function detail(id: string, restatedFrom: string | null) {
  return {
    json: {
      hypothesis: {
        id,
        session_name: `hyp-${id}`,
        session_id: "sess",
        title: `hypothesis ${id}`,
        title_truncated: false,
        owner: "kai",
        status: "archived",
        status_memory_id: "mem",
        updated_at_ms: 1_780_000_000_000,
        restated_from: restatedFrom,
      },
      spec_source: null,
      spec_validation: { valid: false, errors: [] },
    },
  };
}

async function renderArchive(routes: FetchRoutes) {
  const stub = stubFetchRoutes(routes);
  renderWithProviders(<Archive />);
  // Two awaited stages: the board read, then the per-row lineage reads.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Archive", () => {
  it("lists the three TERMINAL states and nothing else", async () => {
    await renderArchive({
      [BOARD]: {
        json: [
          row({ id: "aaaaaaa1", status: "confirmed" }),
          row({ id: "aaaaaaa2", status: "invalidated" }),
          row({ id: "aaaaaaa3", status: "archived" }),
          row({ id: "aaaaaaa4", status: "live" }),
          row({ id: "aaaaaaa5", status: "draft" }),
          row({ id: "aaaaaaa6", status: "challenged" }),
        ],
      },
      "GET /api/hypotheses/aaaaaaa1": detail("aaaaaaa1", null),
      "GET /api/hypotheses/aaaaaaa2": detail("aaaaaaa2", null),
      "GET /api/hypotheses/aaaaaaa3": detail("aaaaaaa3", null),
    });

    expect(screen.getAllByTestId("hypothesis-row")).toHaveLength(3);
    expect(screen.getByTestId("archive-row-aaaaaaa1")).toBeInTheDocument();
    expect(screen.queryByTestId("archive-row-aaaaaaa4")).toBeNull();
  });

  it("shows restated_from lineage, LINKING to the retired hypothesis", async () => {
    await renderArchive({
      [BOARD]: { json: [row({ id: "bbbbbbb1", status: "archived" })] },
      "GET /api/hypotheses/bbbbbbb1": detail("bbbbbbb1", "2b3c4d5e"),
    });

    const lineage = screen.getByTestId("restated-from");
    expect(lineage).toHaveTextContent("restated from");
    expect(within(lineage).getByRole("link")).toHaveAttribute("href", "/hypotheses/2b3c4d5e");
  });

  it("shows NO lineage when the label is absent — without it, a relaunch would read as a fresh thesis", async () => {
    await renderArchive({
      [BOARD]: { json: [row({ id: "bbbbbbb2", status: "confirmed" })] },
      "GET /api/hypotheses/bbbbbbb2": detail("bbbbbbb2", null),
    });
    expect(screen.queryByTestId("restated-from")).toBeNull();
    expect(screen.getByTestId("hypothesis-row")).toBeInTheDocument();
  });

  it("still renders a row whose lineage read failed — losing the row is a worse lie than losing the link", async () => {
    await renderArchive({
      [BOARD]: { json: [row({ id: "bbbbbbb3", status: "archived" })] },
      "GET /api/hypotheses/bbbbbbb3": { status: 503, json: { kind: "unavailable", message: "down" } },
    });
    expect(screen.getByTestId("archive-row-bbbbbbb3")).toBeInTheDocument();
    expect(screen.queryByTestId("restated-from")).toBeNull();
  });

  it("reads the board ONCE and one detail per terminal row — never per board row", async () => {
    const stub = await renderArchive({
      [BOARD]: {
        json: [
          row({ id: "ccccccc1", status: "archived" }),
          row({ id: "ccccccc2", status: "live" }),
          row({ id: "ccccccc3", status: "live" }),
        ],
      },
      "GET /api/hypotheses/ccccccc1": detail("ccccccc1", null),
    });
    expect(stub.countFor(BOARD)).toBe(1);
    expect(stub.mock).toHaveBeenCalledTimes(2);
  });

  it("says so when nothing has concluded", async () => {
    await renderArchive({ [BOARD]: { json: [] } });
    expect(screen.getByTestId("archive-empty")).toBeInTheDocument();
  });
});
