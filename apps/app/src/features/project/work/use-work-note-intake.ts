/**
 * A new scratch note on its way into a Work: an attempt row until the server
 * has it. The attempt lives per Work outside the Files tab, so a refusal stays
 * where the writer left it across tab switches, and is scoped to the signed-in
 * account: an account switch drops it.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { useOptionalAccountEpochSignal } from "../context/account-feature-context";
import { uniqueScratchNoteName } from "./work-file-names";

export type NoteAttempt = {
  key: string;
  name: string;
  state: "pending" | "failed";
};

const useNoteStore = create<{ byWork: Readonly<Record<string, NoteAttempt | null>> }>(() => ({
  byWork: {},
}));

const accountsSeen = new WeakSet<AbortSignal>();

/** The account's end drops every attempt it made. */
function scopeToAccount(accountSignal: AbortSignal | null): void {
  if (!accountSignal || accountsSeen.has(accountSignal)) return;
  accountsSeen.add(accountSignal);
  accountSignal.addEventListener("abort", () => useNoteStore.setState({ byWork: {} }), {
    once: true,
  });
}

export function useWorkNoteIntake(projectId: string, workId: string) {
  const note = useNoteStore((state) => state.byWork[workId] ?? null);
  const createEntry = useCreateContextEntry(projectId);
  const accountSignal = useOptionalAccountEpochSignal();
  // Settling after the account ended would bring a dropped Work's attempt back.
  const record = useCallback(
    (attempt: NoteAttempt | null) => {
      if (accountSignal?.aborted) return;
      scopeToAccount(accountSignal);
      useNoteStore.setState(({ byWork }) => ({ byWork: { ...byWork, [workId]: attempt } }));
    },
    [accountSignal, workId],
  );

  /** Resolves to the note's name once the server has it, else `null`. */
  const sendNote = useCallback(
    async (attempt: NoteAttempt): Promise<string | null> => {
      record(attempt);
      try {
        await createEntry.mutateAsync({
          scheme: "scratch",
          type: "file",
          path: attempt.name,
          content: "",
          workId,
        });
        record(null);
        return attempt.name;
      } catch {
        record({ ...attempt, state: "failed" });
        return null;
      }
    },
    [createEntry, record, workId],
  );
  /** A new dated scratch note, named apart from its siblings and any refused note. */
  const createNote = useCallback(
    (siblingNames: readonly string[]) => {
      const refused = useNoteStore.getState().byWork[workId];
      const name = uniqueScratchNoteName(
        `Scratch note ${new Date().toLocaleDateString().replaceAll("/", "-")}.md`,
        refused ? [...siblingNames, refused.name] : siblingNames,
      );
      return sendNote({ key: crypto.randomUUID(), name, state: "pending" });
    },
    [sendNote, workId],
  );
  /** The refused note again, under its own name. */
  const retryNote = useCallback(() => {
    const refused = useNoteStore.getState().byWork[workId];
    return refused ? sendNote({ ...refused, state: "pending" }) : Promise.resolve(null);
  }, [sendNote, workId]);
  const dismissNote = useCallback(() => record(null), [record]);

  return { note, createNote, retryNote, dismissNote };
}
