import { describe, expect, it } from "vitest";
import { datasetOwnerFor, isOwnDataset, metricDatasetName } from "./datasettrust.js";

const ID = "1a2b3c4d";
const OWN = { createdByWorker: `researcher-${ID}` };

describe("dataset ownership", () => {
  it("names the hypothesis's own researcher as the owner", () => {
    expect(datasetOwnerFor(ID)).toBe(`researcher-${ID}`);
  });

  it("builds the metric dataset name from the BARE id", () => {
    // `hyp-` belongs to session names only — a dataset named `hyp-<id>-<slug>`
    // would never be found by the reader.
    expect(metricDatasetName(ID, "probe-rate")).toBe("1a2b3c4d-probe-rate");
  });

  // THE POSITIVE HALF. A check that only rejects is satisfied by a predicate
  // that rejects everything, which would stop every legitimate tick.
  it("ACCEPTS the hypothesis's own researcher", () => {
    expect(isOwnDataset(OWN, ID)).toBe(true);
  });

  it("rejects another hypothesis's researcher", () => {
    expect(isOwnDataset({ createdByWorker: "researcher-deadbeef" }, ID)).toBe(false);
  });

  it("rejects an unrelated worker", () => {
    expect(isOwnDataset({ createdByWorker: "interviewer" }, ID)).toBe(false);
  });

  // Empty is a FOREIGN writer here, not the application. `dataset_put` refuses
  // an unidentified caller, so every dataset carries a session; an empty worker
  // means a human chat session inside a container, and Wolf's "the application
  // said it" rule needs BOTH provenance fields empty — which no MCP dataset
  // write can produce.
  it("rejects an EMPTY worker rather than treating it as the application", () => {
    expect(isOwnDataset({ createdByWorker: "" }, ID)).toBe(false);
  });

  // Prefix confusion: `researcher-1a2b3c4d` must not match `researcher-1a2b3c4`
  // or a longer id that starts with it.
  it("is exact, not a prefix match", () => {
    expect(isOwnDataset({ createdByWorker: `researcher-${ID}extra` }, ID)).toBe(false);
    expect(isOwnDataset({ createdByWorker: "researcher-1a2b3c4" }, ID)).toBe(false);
  });
});
