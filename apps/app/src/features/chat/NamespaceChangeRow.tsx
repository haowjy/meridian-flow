/**
 * NamespaceChangeRow — the timeline row for a finished `move` or `delete`.
 *
 * The row says what the model did and whether it still stands. The turn's
 * lineage is the source of that (`namespaceChanges`), so a model `undo`, the
 * writer's turn Undo and the writer's restore all reach the row the same way:
 * the lineage refetches and the row follows. The document's name is a door
 * only where the document is now. A delete still applied carries the
 * writer's Restore, here and on the turn's receipt line; its failure stays
 * next to the control the writer used.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { JsonValue, TurnNamespaceChangeItem } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";

import {
  type RestoreDeleteFailure,
  useRestoreDeleteMutation,
} from "@/client/query/useRestoreDeleteMutation";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { Button } from "@/components/ui/button";
import { ActivityRow } from "./ActivityRow";
import { descriptorFor } from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import {
  documentDisplayName,
  documentLocationPath,
  moveDestinationName,
} from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import { sourcePath, stringInput, toolInputObject } from "./tool-command";

/** The write handle a finished move or delete names: the document and its `w<n>`. */
export function namespaceChangeHandle(tool: ToolView): { documentId: string; wId: number } | null {
  const documentId = tool.metadata?.documentId;
  const handle = writeHandleId(tool.result);
  const wId = handle?.match(/^w(\d+)$/)?.[1];
  return typeof documentId === "string" && wId ? { documentId, wId: Number(wId) } : null;
}

function writeHandleId(result: JsonValue | null): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const write = result.write;
  if (!write || typeof write !== "object" || Array.isArray(write)) return undefined;
  return typeof write.id === "string" ? write.id : undefined;
}

export function NamespaceChangeRow({ tool, threadId }: { tool: ToolView; threadId: string }) {
  const handle = namespaceChangeHandle(tool);
  const turnId = tool.keyBlock.turnId;
  const lineage = useTurnLiveLineage(threadId, turnId, { enabled: handle !== null });
  const change =
    (handle &&
      lineage.namespaceChanges?.find(
        (candidate) => candidate.documentId === handle.documentId && candidate.wId === handle.wId,
      )) ??
    null;
  const Icon = descriptorFor(tool).Icon;
  const input = toolInputObject(tool);

  if (stringInput(input, "command") === "move") {
    return (
      <ActivityRow Icon={Icon} status="done" title={<MoveTitle tool={tool} change={change} />} />
    );
  }
  return <DeleteRow tool={tool} threadId={threadId} turnId={turnId} change={change} />;
}

function MoveTitle({ tool, change }: { tool: ToolView; change: TurnNamespaceChangeItem | null }) {
  const input = toolInputObject(tool);
  return (
    <MoveSentence
      from={change?.fromUri ?? sourcePath(input) ?? ""}
      to={change?.toUri ?? stringInput(input, "path") ?? ""}
      undone={change?.status === "reversed"}
    />
  );
}

/**
 * "Moved ch3 to ch3-old", named the way a read row names a document. Applied,
 * the new place is the door; undone, the old one is, since that is where the
 * document is again.
 */
function MoveSentence({ from, to, undone }: { from: string; to: string; undone: boolean }) {
  const fromName = documentDisplayName(from);
  const toName = moveDestinationName(from, to, documentDisplayName);
  const source = undone ? <DocumentName path={from} text={fromName} /> : <Plain>{fromName}</Plain>;
  const destination = undone ? <Plain>{toName}</Plain> : <DocumentName path={to} text={toName} />;
  return (
    <TitleLine status={undone ? t`Undone` : null}>
      <Trans>
        Moved {source} to {destination}
      </Trans>
    </TitleLine>
  );
}

/** "Deleted Chapter 3". Restored, the name is a door again. */
function DeleteSentence({
  path,
  restored,
  status,
  children,
}: {
  path: string;
  restored: boolean;
  status: string | null;
  /** The restore control, on the row that offers it. */
  children?: ReactNode;
}) {
  const document = restored ? (
    <DocumentName path={path} />
  ) : (
    <Plain>{documentDisplayName(path)}</Plain>
  );
  return (
    <TitleLine status={status ?? (restored ? t`Restored` : null)}>
      <Trans>Deleted {document}</Trans>
      {children}
    </TitleLine>
  );
}

/**
 * A turn's move or delete as one line of its receipt, from the lineage alone.
 * A delete that still stands offers the same Restore as its tool row.
 */
export function NamespaceChangeLine({
  change,
  threadId,
  turnId,
}: {
  change: TurnNamespaceChangeItem;
  threadId: string;
  turnId: string;
}) {
  const restore = useRestoreControl(threadId, turnId, change, "receipt");
  if (change.kind === "move") {
    return (
      <MoveSentence
        from={change.fromUri}
        to={change.toUri ?? ""}
        undone={change.status === "reversed"}
      />
    );
  }
  return (
    <>
      <DeleteSentence
        path={change.fromUri}
        restored={change.status === "reversed"}
        status={restore.status}
      >
        {restore.control}
      </DeleteSentence>
      {restore.note ? <RestoreNote className="text-ink-muted">{restore.note}</RestoreNote> : null}
    </>
  );
}

function DeleteRow({
  tool,
  threadId,
  turnId,
  change,
}: {
  tool: ToolView;
  threadId: string;
  turnId: string;
  change: TurnNamespaceChangeItem | null;
}) {
  const restore = useRestoreControl(threadId, turnId, change, "tool");
  const path = change?.fromUri ?? stringInput(toolInputObject(tool), "path") ?? "";
  const title = (
    <DeleteSentence path={path} restored={change?.status === "reversed"} status={restore.status}>
      {restore.control}
    </DeleteSentence>
  );

  return (
    <ActivityRow Icon={descriptorFor(tool).Icon} status="done" title={title}>
      {restore.note ? <RestoreNote>{restore.note}</RestoreNote> : null}
    </ActivityRow>
  );
}

/**
 * The writer's Restore for one delete, wherever the delete is shown: its
 * control while the delete stands, and what came of it. The command's current outcome is shared, with detail on the initiating
 * surface; confirmed status comes from the lineage.
 */
function useRestoreControl(
  threadId: string,
  turnId: string,
  change: TurnNamespaceChangeItem | null,
  surface: "tool" | "receipt",
): { control: ReactNode; note: string | null; status: string | null } {
  const restore = useRestoreDeleteMutation(
    threadId,
    change ? { turnId, documentId: change.documentId, wId: change.wId } : null,
    surface,
    change?.status === "active",
  );
  const path = change?.fromUri ?? "";
  const note = restore.showNote ? restoreNote(restore.outcome, path) : null;
  const status = restore.isPending ? t`Restoring…` : restoreFailureStatus(restore.outcome);
  // The control needs the server's word that the delete still stands; an
  // unloaded or rolled-back change offers nothing to act on.
  if (change?.kind !== "delete" || change.status !== "active" || restore.isPending) {
    return { control: null, note, status };
  }
  const name = documentDisplayName(path);
  const control = (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      aria-label={t`Restore ${name}`}
      onClick={() => {
        restore.mutate();
      }}
      // Pulled into the line box so the row keeps its rhythm.
      className="-my-1 shrink-0 font-medium text-jade-text"
    >
      <Trans>Restore</Trans>
    </Button>
  );
  return { control, note, status };
}

function RestoreNote({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p role="status" data-restore-note className={className}>
      {children}
    </p>
  );
}

/** Both surfaces show the same outcome; only the clicked one expands its cause. */
function restoreFailureStatus(outcome: RestoreDeleteFailure | undefined): string | null {
  switch (outcome?.status) {
    case "location_taken":
      return t`Location taken`;
    case "folder_missing":
      return t`Folder missing`;
    case "nothing_to_restore":
      return t`Nothing to restore`;
    case "permission_denied":
    case "request_failed":
      return t`Can't restore`;
    default:
      return null;
  }
}

/** Why the writer's restore didn't do what they asked; null when it did. */
function restoreNote(outcome: RestoreDeleteFailure | undefined, path: string): string | null {
  switch (outcome?.status) {
    case "location_taken": {
      const place = documentLocationPath(path, true);
      return t`Can't restore: another document is at ${place}. Move or rename that document, then try again.`;
    }
    case "folder_missing":
      return t`Can't restore: the document's original folder is gone.`;
    case "nothing_to_restore":
      return t`There is no deletion to restore.`;
    case "permission_denied":
      return outcome.reason === "work_archived"
        ? t`Can't restore: the document's Work is archived. Unarchive the Work, then try again.`
        : t`Can't restore: you don't have permission to restore this document here.`;
    case "request_failed":
      return t`Can't restore: the request failed. Try again.`;
    default:
      return null;
  }
}

/** One row line: the sentence, then a quiet status word when the change was put back. */
function TitleLine({ status, children }: { status: string | null; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-[var(--chat-space-inline)]">
      {children}
      {status ? (
        <span className="shrink-0 font-normal text-ink-subtle" data-namespace-status>
          {status}
        </span>
      ) : null}
    </span>
  );
}

/** A name that is not a door: the document isn't there anymore. */
function Plain({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate">{children}</span>;
}
