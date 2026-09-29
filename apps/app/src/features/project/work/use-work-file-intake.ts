/**
 * Files a writer is adding to a Work: uploads and new scratch notes, each an
 * attempt row until the catalog has it. Attempts live per Work outside the
 * Files tab, so a failure stays where the writer left it across tab switches.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { create } from "zustand";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { uniqueScratchNoteName } from "./work-file-names";

export type FileAttempt = { key: string; name: string; state: "pending" | "failed" };

type WorkIntake = { uploads: readonly FileAttempt[]; note: FileAttempt | null };

const EMPTY: WorkIntake = { uploads: [], note: null };

const useIntakeStore = create<{ byWork: Readonly<Record<string, WorkIntake>> }>(() => ({
  byWork: {},
}));

function update(workId: string, change: (intake: WorkIntake) => WorkIntake): void {
  useIntakeStore.setState(({ byWork }) => ({
    byWork: { ...byWork, [workId]: change(byWork[workId] ?? EMPTY) },
  }));
}

const settle = (attempts: readonly FileAttempt[], key: string, failed: boolean) =>
  failed
    ? attempts.map((item) => (item.key === key ? { ...item, state: "failed" as const } : item))
    : attempts.filter((item) => item.key !== key);

export function useWorkFileIntake(projectId: string, workId: string) {
  const intake = useIntakeStore((state) => state.byWork[workId] ?? EMPTY);
  const createEntry = useCreateContextEntry(projectId);
  const queryClient = useQueryClient();

  /** Uploads every file at once; each lands or fails on its own row. */
  const submitFiles = useCallback(
    (files: FileList | readonly File[]) => {
      const batch = Array.from(files, (file) => ({ file, key: crypto.randomUUID() }));
      update(workId, (current) => ({
        ...current,
        uploads: [
          ...current.uploads,
          ...batch.map(({ file, key }) => ({ key, name: file.name, state: "pending" as const })),
        ],
      }));
      return Promise.all(
        batch.map(async ({ file, key }) => {
          let failed = false;
          try {
            await uploadIntakePort.intake({
              file,
              intakeId: key,
              scope: { kind: "work", projectId, workId },
            });
            void queryClient.invalidateQueries({
              queryKey: projectQueryKeys.contextCatalogView(projectId, "uploads", workId),
            });
          } catch {
            failed = true;
          }
          update(workId, (current) => ({
            ...current,
            uploads: settle(current.uploads, key, failed),
          }));
        }),
      );
    },
    [projectId, queryClient, workId],
  );

  /** Resolves to the note's name once the server has it, else `null`. */
  const sendNote = useCallback(
    async (attempt: FileAttempt): Promise<string | null> => {
      update(workId, (current) => ({ ...current, note: attempt }));
      try {
        await createEntry.mutateAsync({
          scheme: "scratch",
          type: "file",
          path: attempt.name,
          content: "",
          workId,
        });
        update(workId, (current) => ({ ...current, note: null }));
        return attempt.name;
      } catch {
        update(workId, (current) => ({ ...current, note: { ...attempt, state: "failed" } }));
        return null;
      }
    },
    [createEntry, workId],
  );
  /** A new dated scratch note, named apart from its siblings and any refused note. */
  const createNote = useCallback(
    (siblingNames: readonly string[]) => {
      const refused = useIntakeStore.getState().byWork[workId]?.note;
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
    const refused = useIntakeStore.getState().byWork[workId]?.note;
    return refused ? sendNote({ ...refused, state: "pending" }) : Promise.resolve(null);
  }, [sendNote, workId]);

  const dismissUpload = useCallback(
    (key: string) =>
      update(workId, (current) => ({
        ...current,
        uploads: current.uploads.filter((item) => item.key !== key),
      })),
    [workId],
  );
  const dismissNote = useCallback(
    () => update(workId, (current) => ({ ...current, note: null })),
    [workId],
  );

  return {
    uploads: intake.uploads,
    note: intake.note,
    submitFiles,
    createNote,
    retryNote,
    dismissUpload,
    dismissNote,
  };
}
