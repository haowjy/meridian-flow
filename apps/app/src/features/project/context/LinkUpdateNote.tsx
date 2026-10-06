/**
 * The quiet line a renamed item shows when its move carried links with it.
 * It reads the move's receipt from the replica journal (the operation id was
 * issued at admission), appears when the receipt settles, and lives until the
 * receipt's own deadline (settlement plus four seconds, however often its row
 * remounts). It says nothing when no link followed or the server refused the move.
 * A row with no rename in flight mounts nothing and watches nothing; a watch ends
 * at the deadline. The announcement goes to the app's one polite region, once per
 * operation.
 */
import { plural } from "@lingui/core/macro";
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import {
  NAMESPACE_RECEIPT_NOTE_TTL_MS,
  type NamespaceIntent,
  type ResourceProjectionSnapshot,
  settledNamespaceReceipt,
} from "@meridian/resource-replica";
import { useEffect, useState, useSyncExternalStore } from "react";
import { announce } from "@/client/stores";
import { cn } from "@/lib/utils";
import { useOptionalAccountResourceReplica } from "./account-feature-context";

const FADE_MS = 400;

// Surfaces that remount while a rename lands (the identity bar) keep its operation here.
const renameOperations = new Map<string, { operationId: string; at: number }>();
const renameListeners = new Set<() => void>();

export function rememberRenameOperation(documentId: string, operationId: string): void {
  const now = Date.now();
  // A note outlives its receipt's window by nothing, so older entries are dead weight.
  for (const [id, entry] of renameOperations)
    if (now - entry.at > 2 * NAMESPACE_RECEIPT_NOTE_TTL_MS) renameOperations.delete(id);
  renameOperations.set(documentId, { operationId, at: now });
  for (const listener of renameListeners) listener();
}

export function useRenameOperation(documentId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      renameListeners.add(listener);
      return () => renameListeners.delete(listener);
    },
    () => renameOperations.get(documentId)?.operationId ?? null,
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

type ProjectionIndex = {
  files: ReadonlyMap<string, readonly NamespaceIntent[]>;
  folders: ReadonlyMap<string, readonly NamespaceIntent[]>;
};

// One index per projection snapshot, shared by every watch on it.
const indexes = new WeakMap<ResourceProjectionSnapshot, ProjectionIndex>();

function indexOf(snapshot: ResourceProjectionSnapshot): ProjectionIndex {
  let index = indexes.get(snapshot);
  if (!index) {
    index = {
      files: new Map(snapshot.records.map((r) => [r.resource.identity.documentId, r.intents])),
      folders: new Map(snapshot.folders.map((f) => [f.folderId, f.intents])),
    };
    indexes.set(snapshot, index);
  }
  return index;
}

type SettledMove = { links: number; deadline: number };

/** The move's link count and absolute deadline once it settles locally; watches only while `watching`. */
function useSettledMove(
  projectId: string,
  subject: LinkNoteSubject,
  operationId: string,
  watching: boolean,
): SettledMove | null {
  const replica = useOptionalAccountResourceReplica();
  const [settled, setSettled] = useState<SettledMove | null>(null);
  useEffect(() => {
    if (!watching || !replica) return;
    return replica.observeProjection(
      projectId,
      (snapshot) => {
        const index = indexOf(snapshot);
        const intents = (subject.kind === "folder" ? index.folders : index.files).get(subject.id);
        const intent = intents?.find((candidate) =>
          candidate.attempts.some(
            (attempt) =>
              attempt.request.kind !== "create" && attempt.request.body.operationId === operationId,
          ),
        );
        const receipt = intents ? settledNamespaceReceipt(intents, operationId, Date.now()) : null;
        // The deadline is known once the move settles locally, whatever the server said.
        const next =
          intent?.settledAt === undefined
            ? null
            : {
                links: movedLinkCount(receipt),
                deadline: intent.settledAt + NAMESPACE_RECEIPT_NOTE_TTL_MS,
              };
        setSettled((previous) =>
          previous?.links === next?.links && previous?.deadline === next?.deadline
            ? previous
            : next,
        );
      },
      () => undefined,
    );
  }, [replica, projectId, subject.kind, subject.id, operationId, watching]);
  return settled;
}

// Operations already announced; entries leave once their deadline has passed.
const announced = new Map<string, number>();

function announceOnce(operationId: string, deadline: number, message: string): void {
  const now = Date.now();
  for (const [id, until] of announced) if (until < now) announced.delete(id);
  if (announced.has(operationId)) return;
  announced.set(operationId, deadline);
  announce(message);
}

export function LinkUpdateNote(props: {
  projectId: string;
  subject: LinkNoteSubject;
  /** The operation id `setLocation` or `setFolderLocation` returned, or null before any rename. */
  operationId: string | null;
  /** `stacked` takes its own line under a name that must keep its full width. */
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const { operationId, ...rest } = props;
  return operationId ? <ActiveNote {...rest} operationId={operationId} /> : null;
}

function ActiveNote({
  projectId,
  subject,
  operationId,
  layout = "inline",
  className,
}: {
  projectId: string;
  subject: LinkNoteSubject;
  operationId: string;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  // A stacked note opens its line from zero height, so the row grows rather than jumps.
  const [entered, setEntered] = useState(false);
  const settled = useSettledMove(projectId, subject, operationId, phase !== "gone");
  const links = settled?.links ?? 0;
  const deadline = settled?.deadline;
  const message = plural(links, { one: "Updated # link", other: "Updated # links" });

  useEffect(() => {
    if (deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      setPhase("gone");
      return;
    }
    // Whatever the receipt said, the watch ends at its deadline.
    const gone = window.setTimeout(() => setPhase("gone"), remaining);
    if (links === 0) return () => window.clearTimeout(gone);
    setPhase(remaining <= FADE_MS ? "fading" : "shown");
    setEntered(false);
    const enter = window.requestAnimationFrame(() => setEntered(true));
    announceOnce(operationId, deadline, message);
    const fade = window.setTimeout(() => setPhase("fading"), Math.max(0, remaining - FADE_MS));
    return () => {
      window.cancelAnimationFrame(enter);
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [operationId, links, deadline]);

  if (links === 0 || phase === "gone") return null;
  if (layout === "stacked") {
    const open = entered && phase === "shown";
    return (
      <span
        aria-hidden
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          "motion-reduce:grid-rows-[1fr] motion-reduce:opacity-100 motion-reduce:transition-none",
          className,
        )}
      >
        <span className="min-h-0 overflow-hidden">
          <span className="block truncate text-xs leading-4 text-muted-foreground">{message}</span>
        </span>
      </span>
    );
  }
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
