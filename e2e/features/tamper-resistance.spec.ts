/**
 * X1 — the two attacks, which are the only tests in this project that grade
 * the trust model at all.
 *
 *   (a) FORGED STATE      a container appends `kind=hypothesis, status=confirmed`
 *   (b) HOSTILE RETRACTION a container withdraws Wolf's own trusted state row
 *
 * (b) is strictly more powerful than (a) and defeats the trust rule as it was
 * first written: `notRetractedSQL` hides any row some memory carries
 * `retracts=<id>` for, and it never checks who wrote the retraction. Wolf's
 * answer is to read with retractions VISIBLE and to ignore any retraction whose
 * own provenance is non-empty.
 *
 * 🔴 THE SINGLE MOST IMPORTANT LINE IN THIS FILE.
 * The retraction MUST be written with a container's own `SESSION_TOKEN`, never
 * with `WOLF_API_KEY`. The API key produces EMPTY provenance, which Wolf
 * HONOURS BY DESIGN — that is how Wolf corrects its own mistakes — so a test
 * written with the API key would pass while proving the exact opposite of its
 * claim. `created_by_session` on the retracting memory is therefore asserted
 * NON-EMPTY before anything is asserted about the board.
 *
 * How the token is used without ever being read: `execInSessionContainer` runs
 * the program INSIDE the container, where `$SESSION_TOKEN` already lives. The
 * value never crosses onto the host, never enters a Playwright log and never
 * lands in a trace — and running there is also the closer model of the attack,
 * which is a prompt-injected agent acting from inside its own container.
 */

import { expect, test, type Page } from "@playwright/test";
import {
  createAndGoLive,
  execInSessionContainer,
  IN_CONTAINER_RPC,
  listMemories,
  retire,
  signIn,
  waitFor,
  waitForTick,
  wolf,
  type LiveHypothesis,
  type MemoryRow,
} from "../helpers/x1.js";

test.describe.configure({ mode: "serial" });

interface Tamper {
  reason: "forged_row" | "hostile_retraction" | "cross_hypothesis_write";
  written_by_worker: string;
  written_by_session: string;
  memory_id: string;
}

interface BoardRow {
  id: string;
  status: string;
  tamper?: Tamper[] | null;
}

/**
 * ONE board read, returning this hypothesis's row.
 *
 * Deliberately not a poll. The only thing it retries is a non-200 — a stack
 * that has not answered yet — and it gives up after fifteen seconds, so a
 * broken defence surfaces as `expected "live", received "confirmed"` rather
 * than as a timeout three minutes later.
 */
async function boardRow(page: Page, hypothesisId: string): Promise<BoardRow> {
  const res = await waitFor(
    "GET /api/hypotheses to answer 200",
    async () => {
      const r = await wolf<BoardRow[]>(page.request, "get", "/api/hypotheses");
      return r.status === 200 ? r : null;
    },
    15_000,
    1_000,
  );
  const row = res.body.find((r) => r.id === hypothesisId);
  expect(row, `hypothesis ${hypothesisId} is not on the board at all`).toBeDefined();
  return row!;
}

test.describe("tamper resistance", () => {
  let hyp: LiveHypothesis;

  test("go live on a hypothesis whose condition never trips", async ({ page }) => {
    await signIn(page);
    hyp = await createAndGoLive(page, {
      title: "X1 tamper resistance",
      thesis: "A probe thesis that stays live, so a forged status has something to contradict.",
      interviewMarker: "X1-INTERVIEW-TAMPER",
    });
    await waitForTick(hyp);
  });

  test("(a) a forged status row never becomes state, and is surfaced as tamper", async ({
    page,
  }) => {
    await signIn(page);

    // The tick container appended `kind=hypothesis, name=<id>, status=confirmed`
    // through the core MCP server with its own session token — the same tools a
    // prompt-injected researcher would have.
    const forged = await waitFor(
      "the forged kind=hypothesis row",
      async () => {
        const rows = await listMemories(`kind=hypothesis,name=${hyp.id}`, {
          includeRetracted: true,
        });
        return rows.find((r) => r.labels["status"] === "confirmed") ?? null;
      },
      6 * 60_000,
    );
    // The forgery is real: it exists, it is labelled exactly as authoritative
    // state would be, and only its PROVENANCE distinguishes it.
    expect(forged.labels["status"]).toBe("confirmed");
    expect(forged.created_by_worker).toBe(`researcher-${hyp.id}`);
    expect(forged.created_by_session).not.toBe("");

    // …and the board still shows the REAL status, with a warning naming the
    // writer. `latest_per=name` would otherwise have handed back this row.
    //
    // 🔴 ONE READ, THEN PLAIN ASSERTIONS — deliberately NOT wrapped in a
    // `waitFor`. The board derives from memory on every request, and the row it
    // must react to is already asserted to exist above, so there is nothing
    // left to wait for. It matters because REMOVING A DEFENCE IS IMMEDIATE,
    // VISIBLE DAMAGE: with the trust rule broken, this reads `confirmed` at
    // once. Polling for the tamper flag would turn that into a three-minute
    // "timed out waiting for the board to flag…", which costs three minutes per
    // failure and says nothing about what actually broke (X1 verifier, D4).
    const board = await boardRow(page, hyp.id);
    expect(board.status, "a forged row became state — the trust rule failed").toBe("live");
    const forgedFlag = board.tamper?.find((t) => t.reason === "forged_row");
    expect(
      forgedFlag,
      `no forged_row tamper on the board row: ${JSON.stringify(board.tamper ?? null)}`,
    ).toBeDefined();
    expect(forgedFlag!.written_by_worker).toBe(`researcher-${hyp.id}`);
    expect(forgedFlag!.memory_id).toBe(forged.id);

    // The detail page says the same thing, and renders it.
    await page.goto(`/hypotheses/${hyp.id}`);
    await expect(page.getByTestId("status-chip").first()).toContainText(/live/i);
    await expect(page.getByTestId("severity").first()).toBeVisible();
  });

  test("(b) a hostile retraction cannot withdraw Wolf's own state row", async ({ page }) => {
    await signIn(page);

    // 1. The row to attack: the newest TRUSTED `kind=hypothesis` memory. Its
    //    uuid is discoverable by anything that can search memory, which is
    //    exactly why retraction is the more powerful attack.
    const rows = await listMemories(`kind=hypothesis,name=${hyp.id}`, { includeRetracted: true });
    const trusted = rows.find(
      (r: MemoryRow) => r.created_by_worker === "" && r.created_by_session === "",
    );
    expect(trusted, "no trusted state row to attack").toBeDefined();
    expect(trusted!.labels["status"]).toBe("live");

    // 2. The attack, executed INSIDE the interview session's container with
    //    that container's own SESSION_TOKEN. Nothing here reads the token.
    const program =
      IN_CONTAINER_RPC +
      `
created = rpc("memory_create", {
    "labels": {"kind": "x1-hostile-retraction", "name": ${JSON.stringify(hyp.id)},
               "retracts": ${JSON.stringify(trusted!.id)}},
    "content": "Withdrawing this hypothesis's state row. Written from inside a container.",
    "embed": False,
})
print(json.dumps({"id": created.get("id"),
                  "created_by_worker": created.get("created_by_worker"),
                  "created_by_session": created.get("created_by_session")}))
`;
    const stdout = await execInSessionContainer(hyp.sessionId, program);
    const retraction = JSON.parse(stdout.trim().split("\n").pop()!) as {
      id: string;
      created_by_worker: string;
      created_by_session: string;
    };

    // 🔴 3. THE ASSERTION THAT MAKES THIS TEST MEAN ANYTHING, AND IT COMES
    //    FIRST. A retraction written with WOLF_API_KEY would carry EMPTY
    //    provenance, Wolf would honour it, the board would change, and the
    //    test below would pass while proving the opposite of its claim.
    expect(
      retraction.created_by_session,
      "the retraction carries EMPTY provenance — it was not written from inside a container, " +
        "so this test proves nothing about hostile retraction",
    ).not.toBe("");
    expect(retraction.created_by_session).toBe(hyp.sessionId);
    expect(retraction.created_by_worker).toBe("interviewer");

    // 4. Bob really did hide the row from the default read — the attack
    //    landed, and it is Wolf that refuses to be fooled by it, not Bob.
    const defaultRead = await listMemories(`kind=hypothesis,name=${hyp.id}`);
    expect(
      defaultRead.some((r) => r.id === trusted!.id),
      "notRetractedSQL did not hide the retracted row; this leg is not testing what it claims",
    ).toBe(false);
    const withRetracted = await listMemories(`kind=hypothesis,name=${hyp.id}`, {
      includeRetracted: true,
    });
    expect(withRetracted.some((r) => r.id === trusted!.id)).toBe(true);

    // 5. …and the board is unmoved: the real status, plus a warning naming the
    //    retractor. This is the resurrection attack failing.
    //
    // 🔴 ONE READ, THEN PLAIN ASSERTIONS — same reason as leg (a). A Wolf that
    // honoured this retraction would drop straight back to the previous row
    // (or lose the hypothesis) on the very next request, so a poll here would
    // convert an instant, legible failure into a three-minute timeout.
    const board = await boardRow(page, hyp.id);
    expect(board.status, "a hostile retraction rolled the board back").toBe("live");
    const flag = board.tamper?.find((t) => t.reason === "hostile_retraction");
    expect(
      flag,
      `no hostile_retraction tamper on the board row: ${JSON.stringify(board.tamper ?? null)}`,
    ).toBeDefined();
    expect(flag!.written_by_session).toBe(hyp.sessionId);
    expect(flag!.memory_id).toBe(retraction.id);

    // Both attacks are visible at once, and neither changed the status.
    expect((board.tamper ?? []).map((t) => t.reason).sort()).toEqual(
      expect.arrayContaining(["forged_row", "hostile_retraction"]),
    );

    await page.goto(`/hypotheses/${hyp.id}`);
    await expect(page.getByTestId("status-chip").first()).toContainText(/live/i);
  });

  test("clean up", async ({ page }) => {
    await signIn(page);
    await retire(page, hyp.id, "X1: tamper legs finished.");
  });
});
