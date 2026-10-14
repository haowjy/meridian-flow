import type { ImportCounts, ImportSummary } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { deriveDisplayState, type LocalPhase } from "./display-state";
import type { StopCommand } from "./import-state";

const counts = (patch: Partial<ImportCounts>): ImportCounts => ({
  total: 10,
  landed: 0,
  failed: 0,
  arriving: 10,
  deleted: 0,
  notImported: 0,
  skipped: 0,
  findings: 0,
  ...patch,
});
const summary = (state: ImportSummary["state"]) => ({ state }) as ImportSummary;
const derive = (input: {
  state?: ImportSummary["state"];
  counts?: Partial<ImportCounts>;
  local?: LocalPhase | null;
  stop?: StopCommand;
  fresh?: boolean;
}) =>
  deriveDisplayState({
    summary: input.state ? summary(input.state) : null,
    counts: input.counts ? counts(input.counts) : null,
    local: input.local ?? null,
    stop: input.stop ?? "none",
    activityFresh: input.fresh ?? false,
  });

describe("deriveDisplayState", () => {
  it("is preparing until the server has answered, and importing while this tab uploads", () => {
    expect(derive({ local: { kind: "preparing" } })).toBe("preparing");
    expect(derive({ state: "ready", counts: {}, local: { kind: "uploading" } })).toBe("importing");
  });

  it("tells importing elsewhere from paused by recent activity", () => {
    expect(derive({ state: "ready", counts: {}, fresh: true })).toBe("importing-elsewhere");
    expect(derive({ state: "ready", counts: {}, fresh: false })).toBe("paused");
  });

  it("needs attention only once every file was tried", () => {
    expect(derive({ state: "ready", counts: { arriving: 0, failed: 2, landed: 8 } })).toBe(
      "needs-attention",
    );
    expect(derive({ state: "ready", counts: { arriving: 1, failed: 2, landed: 7 } })).toBe(
      "paused",
    );
  });

  it("lets what this tab did to the import override the server's word", () => {
    expect(derive({ state: "ready", counts: {}, local: { kind: "not-started", code: null } })).toBe(
      "didnt-start",
    );
    expect(derive({ state: "finished", counts: { arriving: 0, landed: 10 } })).toBe("finished");
  });

  it("follows a Stop this tab asked for, whether or not it holds the files", () => {
    expect(derive({ state: "ready", counts: {}, stop: "stopping" })).toBe("stopping");
    expect(derive({ state: "ready", counts: {}, stop: "failed" })).toBe("couldnt-stop");
    expect(derive({ state: "finished", counts: { arriving: 0 }, stop: "failed" })).toBe("finished");
    // Stopped before the plan was sent: there is no server import, and nothing to wait for.
    expect(derive({ stop: "stopped", local: { kind: "idle" } })).toBe("finished");
  });
});
