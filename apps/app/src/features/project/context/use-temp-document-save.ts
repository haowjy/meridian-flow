/**
 * useTempDocumentSave — the durable-save flow for a device-local document.
 *
 * Owns the save state machine (editing → saving → conflict/failed), the
 * destination, and the suggested-vs-owned name state, persisting name changes
 * to the temp-docs store. Presentation (fields, popover, focus choreography)
 * lives in `TempDocumentSaveBar`; the host editor reports content changes via
 * `noteContent` and supplies serialization via `captureContent`.
 *
 * The save protocol is snapshot-based so newer words can never be lost: an
 * immutable content/destination/name/revision snapshot is captured up front,
 * and the temp document is removed only when its revision still equals the
 * snapshot's after the durable write lands.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { JSONContent } from "@tiptap/core";
import { useRef, useState } from "react";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { type TempDocument, useTempDocsStore } from "@/client/stores";
import { invalidContextEntryNameReason, joinContextEntryPath } from "./context-entry-name";
import {
  initialTempDocumentName,
  takeTempDocumentNameOwnership,
  updateSuggestedTempDocumentName,
} from "./temp-document-name";

export type Destination = { scheme: ProjectContextTreeScheme; path: string };

type SaveSnapshot = {
  documentId: string;
  content: string;
  destination: Destination;
  name: string;
  revision: number;
};

export type TempSaveState =
  | { kind: "editing" }
  | { kind: "saving"; snapshot: SaveSnapshot }
  | { kind: "conflict"; snapshot: SaveSnapshot; path: string }
  | { kind: "failed"; reason: "generic" | "newer-words" };

// Session memory, not per-document: the writer's last save destination is the
// best default for the next temp document too.
let lastSuccessfulDestination: Destination = { scheme: "manuscript", path: "/" };

export type TempDocumentSave = ReturnType<typeof useTempDocumentSave>;

export function useTempDocumentSave({
  projectId,
  activeThreadId,
  document,
  captureContent,
  onOpenSaved,
  onVerificationFailed,
}: {
  projectId: string;
  activeThreadId: string | null;
  document: TempDocument;
  /** Serialize the live editor's content to markdown; null while pre-mount. */
  captureContent: () => string | null;
  onOpenSaved: (scheme: ProjectContextTreeScheme, path: string) => void;
  onVerificationFailed: () => void;
}) {
  const updateSaveName = useTempDocsStore((state) => state.updateSaveName);
  const removeTemp = useTempDocsStore((state) => state.removeTemp);
  const [destination, setDestination] = useState<Destination>(lastSuccessfulDestination);
  const [saveState, setSaveState] = useState<TempSaveState>({ kind: "editing" });
  const [nameState, setNameState] = useState(() =>
    document.saveName === undefined
      ? initialTempDocumentName(document.content, document.name)
      : { value: document.saveName, owned: document.saveNameOwned ?? false },
  );
  // Editor onUpdate fires outside React's render cycle; the ref keeps
  // suggested-name updates race-free against user renames.
  const nameStateRef = useRef(nameState);
  nameStateRef.current = nameState;
  const inFlightRef = useRef(false);
  const mutation = useCreateContextEntry(projectId, { activeThreadId });

  const commitName = (next: { value: string; owned: boolean }) => {
    nameStateRef.current = next;
    setNameState(next);
    updateSaveName(projectId, document.id, next.value, next.owned);
  };

  /** The user typed a name — it becomes owned and stops tracking content. */
  const rename = (value: string) => {
    commitName(takeTempDocumentNameOwnership(nameStateRef.current, value));
    // Renaming clears a stale failure/conflict, but must never clear an
    // in-flight save: doing so re-enabled the Save button mid-request and
    // allowed a duplicate write.
    setSaveState((prev) => (prev.kind === "saving" ? prev : { kind: "editing" }));
  };

  /** The editor content changed — refresh the suggested name unless owned. */
  const noteContent = (content: JSONContent) => {
    const next = updateSuggestedTempDocumentName(nameStateRef.current, content);
    if (next.value !== nameStateRef.current.value) commitName(next);
  };

  const clearFailure = () => setSaveState({ kind: "editing" });

  /**
   * `target` overrides the stored destination/name for this save. The save
   * bar passes its parsed field value here so a submit straight from typing
   * never races the async state commits of `rename`/`selectDestination`.
   */
  async function save(target?: { destination: Destination; name: string }) {
    // Synchronous re-entry guard: React state (`saveState`) commits async, so
    // a second Enter/click in the same tick would pass a state-based check.
    if (inFlightRef.current) return;
    const saveDestination = target?.destination ?? destination;
    const trimmed = (target?.name ?? nameState.value).trim();
    const validation = trimmed ? invalidContextEntryNameReason(trimmed) : t`Name is required`;
    if (validation) {
      setSaveState({ kind: "failed", reason: "generic" });
      return;
    }
    const content = captureContent();
    if (content === null) return;
    const path = joinContextEntryPath(saveDestination.path, trimmed);
    const snapshot: SaveSnapshot = {
      documentId: document.id,
      content,
      destination: saveDestination,
      name: trimmed,
      revision: document.revision,
    };
    inFlightRef.current = true;
    setSaveState({ kind: "saving", snapshot });
    try {
      const result = await mutation.mutateAsync({
        scheme: saveDestination.scheme,
        type: "file",
        path,
        content: snapshot.content,
      });
      if (result.status === "conflict") {
        setSaveState({ kind: "conflict", snapshot, path });
        return;
      }
      lastSuccessfulDestination = saveDestination;
      onOpenSaved(saveDestination.scheme, path);
      const current = useTempDocsStore
        .getState()
        .byProject[projectId]?.find((candidate) => candidate.id === snapshot.documentId);
      if (current?.revision === snapshot.revision) {
        removeTemp(projectId, snapshot.documentId);
      } else {
        // The durable snapshot saved, but the writer kept typing: keep the
        // temp document (and its newer words) alive rather than dropping them.
        setSaveState({ kind: "failed", reason: "newer-words" });
        onVerificationFailed();
      }
    } catch {
      setSaveState({ kind: "failed", reason: "generic" });
      onVerificationFailed();
    } finally {
      inFlightRef.current = false;
    }
  }

  return {
    destination,
    selectDestination: setDestination,
    name: nameState.value,
    rename,
    noteContent,
    saveState,
    clearFailure,
    save,
    saving: saveState.kind === "saving",
  };
}
