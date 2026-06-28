/**
 * TurnChangeFooter — compact per-turn summary and undo/redo controls.
 *
 * Scans settled assistant turns for write/edit tool calls, gathers the touched
 * documents into one footer, and calls the thread reverse API for per-document
 * or whole-turn undo/redo. Document content refresh is handled by Yjs sync; the
 * footer keeps only local affordance state.
 */
import { t } from "@lingui/core/macro";
import type {
  DocumentReversalResult,
  ReversalOutcome,
  Turn,
  WriteStatus,
} from "@meridian/contracts/protocol";
import { ChevronDown, LoaderCircle, Redo2, Undo2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import type { ReversalDirection } from "@/client/api/reverse-api";
import {
  useReverseDocumentMutation,
  useReverseTurnMutation,
} from "@/client/query/useReverseMutation";
import { displayContextPath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { useChatContextNavigation } from "./ChatContextNavigation";
import { turnWrittenDocuments, type WrittenDocument } from "./turn-written-documents";

export type TurnChangeFooterProps = {
  threadId: string;
  turn: Turn;
  writtenDocuments?: WrittenDocument[];
};

type RowState = {
  disposition: "applied" | "reversed" | "disabled";
  statusText?: string;
};

export function TurnChangeFooter({ threadId, turn, writtenDocuments }: TurnChangeFooterProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const documents = useMemo(
    () => writtenDocuments ?? turnWrittenDocuments(turn),
    [turn, writtenDocuments],
  );
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [turnPending, setTurnPending] = useState(false);
  const documentMutation = useReverseDocumentMutation(threadId);
  const turnMutation = useReverseTurnMutation(threadId);

  if (documents.length === 0) return null;

  const rowState = (uri: string): RowState => rows[uri] ?? { disposition: "applied" };
  const actionableDocuments = documents.filter(
    (doc) => rowState(doc.uri).disposition !== "disabled",
  );
  const allActionableReversed =
    actionableDocuments.length > 0 &&
    actionableDocuments.every((doc) => rowState(doc.uri).disposition === "reversed");
  const summary = `${documentIcon} ${fileCountLabel(documents.length)}${allActionableReversed ? ` ${t`(all undone)`}` : ""}`;
  const turnDirection: ReversalDirection = allActionableReversed ? "redo" : "undo";
  const turnActionDisabled = turnPending || Boolean(pendingUri) || actionableDocuments.length === 0;

  async function reverseOne(doc: WrittenDocument) {
    const current = rowState(doc.uri);
    if (current.disposition === "disabled" || pendingUri || turnPending) return;
    const direction: ReversalDirection = current.disposition === "reversed" ? "redo" : "undo";
    setPendingUri(doc.uri);
    try {
      const outcome = await documentMutation.mutateAsync({
        turnId: turn.id,
        uri: doc.uri,
        direction,
      });
      setRows((prev) => ({
        ...prev,
        [doc.uri]: stateFromDocumentResult(direction, outcome.documents[0], current),
      }));
    } catch (error) {
      setRows((prev) => ({
        ...prev,
        [doc.uri]: { ...current, statusText: errorMessage(error) },
      }));
    } finally {
      setPendingUri(null);
    }
  }

  async function reverseAll() {
    if (turnActionDisabled) return;
    setTurnPending(true);
    try {
      const outcome = await turnMutation.mutateAsync({ turnId: turn.id, direction: turnDirection });
      setRows((prev) => {
        const next = { ...prev };
        for (const result of outcome.documents) {
          next[result.uri] = stateFromDocumentResult(turnDirection, result, prev[result.uri]);
        }
        if (outcome.documents.length === 0) {
          for (const doc of documents) {
            next[doc.uri] = stateFromOutcomeStatus(turnDirection, outcome, prev[doc.uri]);
          }
        }
        return next;
      });
    } catch (error) {
      const message = errorMessage(error);
      setRows((prev) =>
        Object.fromEntries(
          documents.map((doc) => [
            doc.uri,
            { ...(prev[doc.uri] ?? { disposition: "applied" }), statusText: message },
          ]),
        ),
      );
    } finally {
      setTurnPending(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-subtle px-3 py-2 text-[12.5px] text-ink-muted">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="focus-ring -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-card"
      >
        <span className="min-w-0 flex-1 truncate font-medium text-ink-strong">{summary}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-ink-subtle transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div id={panelId} className="mt-2 space-y-1.5 border-t border-border pt-2">
          <ul className="space-y-1">
            {documents.map((doc) => {
              const state = rowState(doc.uri);
              const pending = pendingUri === doc.uri;
              return (
                <li key={doc.uri} className="flex min-w-0 items-center gap-2">
                  <DocumentName document={doc} onOpenContextUri={openContextUri} />
                  {state.statusText ? (
                    <span className="shrink truncate text-ink-subtle">{state.statusText}</span>
                  ) : null}
                  <button
                    type="button"
                    disabled={state.disposition === "disabled" || pending || turnPending}
                    onClick={() => void reverseOne(doc)}
                    className="focus-ring inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 font-medium text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink-strong disabled:cursor-default disabled:opacity-50"
                  >
                    {pending ? (
                      <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
                    ) : state.disposition === "reversed" ? (
                      <Redo2 className="size-3.5" aria-hidden />
                    ) : (
                      <Undo2 className="size-3.5" aria-hidden />
                    )}
                    {state.disposition === "reversed" ? t`Redo` : t`Undo`}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              disabled={turnActionDisabled}
              onClick={() => void reverseAll()}
              className="focus-ring inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-ink-muted transition-colors hover:bg-card hover:text-ink-strong disabled:cursor-default disabled:opacity-50"
            >
              {turnPending ? (
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
              ) : turnDirection === "redo" ? (
                <Redo2 className="size-3.5" aria-hidden />
              ) : (
                <Undo2 className="size-3.5" aria-hidden />
              )}
              {turnDirection === "redo" ? t`Redo all` : t`Undo all`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DocumentName({
  document,
  onOpenContextUri,
}: {
  document: WrittenDocument;
  onOpenContextUri: ((uri: string) => void) | null;
}) {
  const label = basename(displayContextPath(document.uri, document.path));
  if (!onOpenContextUri) {
    return <span className="min-w-0 flex-1 truncate font-mono text-ink-strong">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring min-w-0 flex-1 truncate rounded-sm text-left font-mono text-ink-strong underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
}

function stateFromDocumentResult(
  direction: ReversalDirection,
  result: Pick<DocumentReversalResult, "status" | "text"> | undefined,
  previous: RowState | undefined,
): RowState {
  if (!result) return stateFromStatus(direction, "internal_error", undefined, previous);
  return stateFromStatus(direction, result.status, result.text, previous);
}

function stateFromOutcomeStatus(
  direction: ReversalDirection,
  outcome: Pick<ReversalOutcome, "status">,
  previous: RowState | undefined,
): RowState {
  return stateFromStatus(direction, outcome.status, undefined, previous);
}

function stateFromStatus(
  direction: ReversalDirection,
  status: WriteStatus,
  text: string | undefined,
  previous: RowState | undefined,
): RowState {
  const fallback = previous ?? { disposition: direction === "undo" ? "applied" : "reversed" };
  if (status === "reversed" || status === "reconciled") {
    return { disposition: direction === "undo" ? "reversed" : "applied" };
  }
  if (status === "nothing_to_undo") return { disposition: "reversed" };
  if (status === "nothing_to_redo") return { disposition: "applied" };
  if (status === "expired") {
    return { disposition: "disabled", statusText: t`Can no longer be undone` };
  }
  if (status === "cant_undo_dependent") {
    return { ...fallback, statusText: t`A later edit depends on this` };
  }
  if (status === "partial") {
    return { ...fallback, statusText: t`Some files could not be updated` };
  }
  if (status === "success") return fallback;
  return { ...fallback, statusText: text || statusLabel(status) };
}

function statusLabel(status: WriteStatus): string {
  switch (status) {
    case "not_found":
      return t`Edit not found`;
    case "ambiguous_match":
      return t`More than one edit matched`;
    case "invalid_write":
      return t`Edit cannot be reversed`;
    case "document_not_found":
      return t`Document not found`;
    case "partial_failure":
      return t`Some files could not be updated`;
    case "internal_error":
      return t`Undo failed`;
    default:
      return status;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t`Undo failed`;
}

function fileCountLabel(count: number): string {
  return count === 1 ? t`1 file changed` : t`${count} files changed`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

const documentIcon = "📝";
