/** Risk: tabs disagree about ownership, or a historical created root is resurrected after deletion. */

import type { ImportSummary } from "@meridian/contracts";
import { expect, it } from "vitest";
import type { LocalUpload } from "./import-coordinator";
import { pendingRoot } from "./pending-roots";
import { toastState } from "./toast-presentation";

const summary: ImportSummary = {
  importId: "i",
  projectId: "p",
  state: "uploading",
  label: { kind: "folder", name: "Book", count: 3 },
  destination: { folderUri: "kb://", folderId: null, fellBack: false },
  root: { id: "root", name: "Book", created: false },
  counts: {
    files: 3,
    bytes: 30,
    received: 3,
    receivedBytes: 30,
    prepared: 0,
    organized: 0,
    skipped: 0,
    failed: 0,
    needsLook: 0,
  },
  waiting: false,
  reason: null,
  lastActivityAt: new Date(0).toISOString(),
};
it("presents age, local ownership, preparation and all five root rules without drawing staged children", () => {
  const rows: [Partial<ImportSummary>, LocalUpload, number, string][] = [
    [{}, {}, 59999, "paused"],
    [{}, { remoteUntil: 60000 }, 59999, "elsewhere"],
    [{}, { remoteUntil: 60000 }, 60000, "paused"],
    [{}, { phase: "uploading" }, 90000, "uploading"],
    [{}, { phase: "stalled" }, 1, "stalled"],
    [{ state: "organizing" }, {}, 0, "organizing"],
    [{ state: "organizing", waiting: true }, {}, 0, "waiting"],
    [
      { state: "organizing", counts: { ...summary.counts, prepared: 2, failed: 1 } },
      {},
      0,
      "adding",
    ],
    [{ state: "organizing", counts: { ...summary.counts, organized: 3 } }, {}, 0, "adding"],
    [{ state: "failed" }, {}, 0, "failed"],
    [{ state: "organizing" }, { stopAsked: true }, 0, "stop"],
    [{ state: "finished" }, {}, 0, "done"],
    [{ state: "finished", counts: { ...summary.counts, needsLook: 1 } }, {}, 0, "needs-look"],
  ];
  for (const [patch, local, now, expected] of rows)
    expect(toastState({ ...summary, ...patch }, local, now)).toBe(expected);
  const fresh = { seen: false, drawn: false };
  const drawn = pendingRoot(summary, fresh, false, 0);
  expect(drawn.draw).toBe(true);
  const seen = pendingRoot(summary, drawn.memory, true, 1);
  expect(seen.draw).toBe(false);
  expect(pendingRoot(summary, seen.memory, false, 2).draw).toBe(false);
  const finished = {
    ...summary,
    state: "finished" as const,
    root: { ...summary.root!, created: true },
  };
  const bridge = pendingRoot(finished, drawn.memory, false, 10);
  expect(bridge.draw).toBe(true);
  expect(pendingRoot(finished, bridge.memory, false, 30010).draw).toBe(false);
  expect(pendingRoot(finished, fresh, false, 0).draw).toBe(false);
  expect(pendingRoot({ ...summary, state: "cancelled" }, drawn.memory, false, 0).draw).toBe(false);
  expect(pendingRoot({ ...summary, root: null }, fresh, false, 0).draw).toBe(false);
});
