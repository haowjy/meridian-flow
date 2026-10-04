/**
 * The quiet line a renamed item shows when its move carried links with it.
 * It reads the move's receipt from the replica journal (the operation id was
 * issued at admission), appears when the receipt settles, fades with the
 * receipt's four-second window and says nothing when no link followed or the
 * server refused the move. The announcement goes to the app's one polite region.
 */
import { plural } from "@lingui/core/macro";
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { NAMESPACE_RECEIPT_NOTE_TTL_MS, settledNamespaceReceipt } from "@meridian/resource-replica";
import { useEffect, useState, useSyncExternalStore } from "react";
import { announce } from "@/client/stores";
import { cn } from "@/lib/utils";
import { useAccountResourceProjection } from "./account-feature-context";

const FADE_MS = 400;

// Surfaces that remount while a rename lands (the identity bar) keep its operation here.
const renameOperations = new Map<string, string>();
const renameListeners = new Set<() => void>();

export function rememberRenameOperation(documentId: string, operationId: string): void {
  renameOperations.set(documentId, operationId);
  for (const listener of renameListeners) listener();
}

export function useRenameOperation(documentId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      renameListeners.add(listener);
      return () => renameListeners.delete(listener);
    },
    () => renameOperations.get(documentId) ?? null,
    () => null,
  );
}

/** Links that follow a settled move; refused moves, deletes and moves without links count none. */
export function movedLinkCount(receipt: ContextOperationReceipt | null): number {
  if (receipt?.command.kind !== "move") return 0;
  const { result } = receipt as Extract<ContextOperationReceipt, { command: { kind: "move" } }>;
  return result.ok ? (result.value.linkUpdate?.links ?? 0) : 0;
}

export type LinkNoteSubject = { kind: "file" | "folder"; id: string };

export function LinkUpdateNote({
  projectId,
  subject,
  operationId,
  className,
}: {
  projectId: string;
  subject: LinkNoteSubject;
  /** The operation id `setLocation` or `setFolderLocation` returned, or null before any rename. */
  operationId: string | null;
  className?: string;
}) {
  const { records, folders } = useAccountResourceProjection(projectId);
  const intents =
    subject.kind === "folder"
      ? folders.find((folder) => folder.folderId === subject.id)?.intents
      : records.find((record) => record.resource.identity.documentId === subject.id)?.intents;
  const count =
    operationId && intents
      ? movedLinkCount(settledNamespaceReceipt(intents, operationId, Date.now()))
      : 0;
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  const visible = count > 0;
  const message = plural(count, { one: "Updated # link", other: "Updated # links" });

  useEffect(() => {
    if (!visible) return;
    setPhase("shown");
    announce(message);
    const fade = window.setTimeout(
      () => setPhase("fading"),
      NAMESPACE_RECEIPT_NOTE_TTL_MS - FADE_MS,
    );
    const gone = window.setTimeout(() => setPhase("gone"), NAMESPACE_RECEIPT_NOTE_TTL_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [operationId, visible]);

  if (!visible || phase === "gone") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "ml-2 shrink-0 text-xs text-muted-foreground transition-opacity duration-300",
        phase === "fading" && "opacity-0",
        "motion-reduce:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      {message}
    </span>
  );
}
