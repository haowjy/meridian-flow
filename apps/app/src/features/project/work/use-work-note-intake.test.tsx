// @vitest-environment jsdom
/**
 * A refused New note keeps its row after the Files tab remounts, retries under
 * its own name, and an account switch drops it.
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkNoteIntake } from "./use-work-note-intake";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync }),
}));
const account = vi.hoisted(() => ({ epoch: new AbortController() }));
vi.mock("../context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => account.epoch.signal,
}));

let intake!: ReturnType<typeof useWorkNoteIntake>;
function Probe({ workId }: { workId: string }) {
  intake = useWorkNoteIntake("project-1", workId);
  return null;
}

it("keeps a refused note after the tab remounts and retries it under the same name", async () => {
  mutateAsync.mockRejectedValueOnce(new Error("Rejected"));
  await withReactRoot(<Probe workId="work-1" />, async () => {
    await act(async () => {
      expect(await intake.createNote(["Scratch note.md"])).toBeNull();
    });
    expect(intake.note?.state).toBe("failed");
  });
  let refused = "";
  await withReactRoot(<Probe workId="work-1" />, async () => {
    refused = intake.note?.name ?? "";
    expect(intake.note?.state).toBe("failed");
    mutateAsync.mockResolvedValueOnce(undefined);
    await act(async () => {
      expect(await intake.retryNote()).toBe(refused);
    });
    expect(intake.note).toBeNull();
  });
  expect(mutateAsync).toHaveBeenLastCalledWith(
    expect.objectContaining({ scheme: "scratch", path: refused, workId: "work-1" }),
  );
});

it("drops the attempt when the account ends, and one settling after writes none", async () => {
  let refuse!: (error: Error) => void;
  mutateAsync
    .mockRejectedValueOnce(new Error("Rejected"))
    .mockImplementationOnce(() => new Promise((_, fail) => (refuse = fail)));
  await withReactRoot(<Probe workId="work-2" />, async () => {
    await act(async () => {
      await intake.createNote([]);
    });
    expect(intake.note?.state).toBe("failed");
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = intake.retryNote();
    });
    expect(intake.note?.state).toBe("pending");
    await act(async () => account.epoch.abort());
    expect(intake.note).toBeNull();
    await act(async () => {
      refuse(new Error("Aborted"));
      await pending;
    });
    expect(intake.note).toBeNull();
  });
  account.epoch = new AbortController();
});
