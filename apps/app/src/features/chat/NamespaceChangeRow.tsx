/**
 * NamespaceChangeRow — the timeline row for a finished `move` or `delete`.
 *
 * The row says what the model did and whether it still stands. The turn's
 * lineage is the source of that (`namespaceChanges`), so a model `undo`, the
 * writer's turn Undo and the writer's restore all reach the row the same way:
 * the lineage refetches and the row follows. The document's name is a door
 * only where the document is now. A delete still applied carries the
 * writer's Restore; its failure stays on the row, next to the control.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue, TurnNamespaceChangeItem } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";

import type { RestoreDeleteOutcome } from "@/client/api/restore-delete-api";
import { useRestoreDeleteMutation } from "@/client/query/useRestoreDeleteMutation";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { Button } from "@/components/ui/button";
import { ActivityRow } from "./ActivityRow";
import { descriptorFor, moveDestinationName } from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import { documentDisplayName, documentFileName } from "./document-display-name";
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
 * "Moved ch3.md to ch3-old.md". Applied, the new place is the door; undone,
 * the old one is, since that is where the document is again.
 */
function MoveSentence({ from, to, undone }: { from: string; to: string; undone: boolean }) {
  const fromName = documentFileName(from);
  const toName = moveDestinationName(from, to);
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
  children,
}: {
  path: string;
  restored: boolean;
  /** The restore control, on the row that offers it. */
  children?: ReactNode;
}) {
  const document = restored ? (
    <DocumentName path={path} />
  ) : (
    <Plain>{documentDisplayName(path)}</Plain>
  );
  return (
    <TitleLine status={restored ? t`Restored` : null}>
      <Trans>Deleted {document}</Trans>
      {children}
    </TitleLine>
  );
}

/** A turn's move or delete as one line of its receipt, from the lineage alone. */
export function NamespaceChangeLine({ change }: { change: TurnNamespaceChangeItem }) {
  return change.kind === "move" ? (
    <MoveSentence
      from={change.fromUri}
      to={change.toUri ?? ""}
      undone={change.status === "reversed"}
    />
  ) : (
    <DeleteSentence path={change.fromUri} restored={change.status === "reversed"} />
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
  const restore = useRestoreDeleteMutation(threadId);
  const path = change?.fromUri ?? stringInput(toolInputObject(tool), "path") ?? "";
  const name = documentDisplayName(path);
  const restored = change?.status === "reversed";
  // The control needs the server's word that the delete still stands; an
  // unloaded or rolled-back change offers nothing to act on.
  const restorable = change?.status === "active" && !restore.isPending;
  const note = restoreNote(restore.isError ? "request_failed" : restore.data, path);

  const title = (
    <DeleteSentence path={path} restored={restored}>
      {restorable ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          aria-label={t`Restore ${name}`}
          onClick={() => {
            restore.mutate({ turnId, documentId: change.documentId, wId: change.wId });
          }}
          // Pulled into the line box so the row keeps its rhythm.
          className="-my-1 shrink-0 font-medium text-jade-text"
        >
          <Trans>Restore</Trans>
        </Button>
      ) : null}
    </DeleteSentence>
  );

  return (
    <ActivityRow Icon={descriptorFor(tool).Icon} status="done" title={title}>
      {note ? (
        <p role="status" data-restore-note>
          {note}
        </p>
      ) : null}
    </ActivityRow>
  );
}

/** Why the writer's restore didn't do what they asked; null when it did. */
function restoreNote(
  outcome: RestoreDeleteOutcome | "request_failed" | undefined,
  path: string,
): string | null {
  switch (outcome) {
    case "location_taken": {
      const place = documentPath(path);
      return t`Couldn't restore it. Something else is at ${place} now.`;
    }
    case "folder_missing":
      return t`Couldn't restore it. Its folder is gone.`;
    case "not_applied":
      return t`It's already restored.`;
    case "request_failed":
      return t`Couldn't restore it. Try again.`;
    default:
      return null;
  }
}

/** The document's place in its section, the way the writer's tree shows it. */
function documentPath(uri: string): string {
  const parsed = parseUnifiedContextUri(uri);
  return (parsed.ok ? parsed.value.path : uri).replace(/^\/+/, "");
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
