import type { ImportEntryReport } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import type { HeldFile } from "./manifest";
import { type UploadOutcome, uploadFiles } from "./uploader";

const held = (entryId: number): HeldFile => ({
  entryId,
  rootId: 0,
  path: `f${entryId}.md`,
  file: new File(["x"], `f${entryId}.md`),
});
const answer = (entryId: number) => ({ entryId, state: "landed" }) as ImportEntryReport;

describe("uploadFiles", () => {
  it("fails only the file that fails when its batch is retried one at a time", async () => {
    const outcomes: UploadOutcome[] = [];
    await uploadFiles({
      files: [held(1), held(2), held(3)],
      signal: new AbortController().signal,
      send: async (parts) => {
        if (parts.some((part) => part.entryId === 2)) throw new Error("injected 500");
        return { entries: parts.map((part) => answer(part.entryId)) };
      },
      onOutcome: (batch) => outcomes.push(...batch),
    });
    expect(
      outcomes
        .filter((o) => o.kind === "answered")
        .map((o) => o.kind === "answered" && o.entry.entryId)
        .sort(),
    ).toEqual([1, 3]);
    expect(
      outcomes.filter((o) => o.kind === "failed").map((o) => o.kind === "failed" && o.entryId),
    ).toEqual([2]);
  });

  it("stops sending once aborted", async () => {
    const control = new AbortController();
    const sent: number[] = [];
    await uploadFiles({
      files: Array.from({ length: 5 }, (_, i) => ({
        ...held(i),
        file: new File([new Uint8Array(9 * 1024 * 1024)], "big.bin"),
      })),
      signal: control.signal,
      send: async (parts) => {
        sent.push(...parts.map((part) => part.entryId));
        control.abort();
        return { entries: parts.map((part) => answer(part.entryId)) };
      },
      onOutcome: () => {},
    });
    expect(sent.length).toBeLessThan(5);
  });
});
