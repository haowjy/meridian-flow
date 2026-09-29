/**
 * Files a writer is adding to a Work: uploads and new scratch notes, each an
 * attempt row until the catalog has it. An upload the server has taken keeps
 * its row until the Uploads catalog lists the same document, so the file never
 * drops out of the list between the two. Attempts live per Work outside the
 * Files tab, so a failure stays where the writer left it across tab switches.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { uniqueScratchNoteName } from "./work-file-names";

export type FileAttempt = {
  key: string;
  name: string;
  state: "pending" | "failed";
  /** Set once the server has the upload; the row stays until the catalog lists it. */
  documentId?: string;
};

/** The catalog an upload lands in, looked up by the document the server made. */
type UploadCatalog = { findDocument(documentId: string): unknown } | null | undefined;

const listedIn = (catalog: UploadCatalog) => (attempt: FileAttempt) =>
  attempt.documentId !== undefined && Boolean(catalog?.findDocument(attempt.documentId));

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

const settle = (
  attempts: readonly FileAttempt[],
  key: string,
  outcome: { documentId: string } | "failed",
) =>
  attempts.map((item) =>
    item.key !== key
      ? item
      : outcome === "failed"
        ? { ...item, state: "failed" as const }
        : { ...item, documentId: outcome.documentId },
  );

export function useWorkFileIntake(projectId: string, workId: string, uploadCatalog: UploadCatalog) {
  const intake = useIntakeStore((state) => state.byWork[workId] ?? EMPTY);
  // The catalog row and the retired attempt swap in the same render; the
  // store is pruned after, so a listed upload never shows twice.
  const listed = listedIn(uploadCatalog);
  const uploads = intake.uploads.filter((attempt) => !listed(attempt));
  const landed = uploads.length !== intake.uploads.length;
  useEffect(() => {
    if (!landed) return;
    const retire = listedIn(uploadCatalog);
    update(workId, (current) => ({
      ...current,
      uploads: current.uploads.filter((attempt) => !retire(attempt)),
    }));
  }, [landed, uploadCatalog, workId]);
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
          let outcome: { documentId: string } | "failed";
          try {
            const { documentId } = await uploadIntakePort.intake({
              file,
              intakeId: key,
              scope: { kind: "work", projectId, workId },
            });
            outcome = { documentId };
            void queryClient.invalidateQueries({
              queryKey: projectQueryKeys.contextCatalogView(projectId, "uploads", workId),
            });
          } catch {
            outcome = "failed";
          }
          update(workId, (current) => ({
            ...current,
            uploads: settle(current.uploads, key, outcome),
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
    uploads,
    note: intake.note,
    submitFiles,
    createNote,
    retryNote,
    dismissUpload,
    dismissNote,
  };
}
