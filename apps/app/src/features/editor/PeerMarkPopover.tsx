/** Anchored detail and recovery surface for one session peer mark. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { changeTrailDetailKey, readChangeTrail } from "@/client/change-trails";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { changeKindLabel } from "@/core/editor/change-mark-labels";
import { collaborationColorFor } from "@/core/editor/collaboration-colors";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { SessionMarker } from "@/core/editor/session-marker-store";
import { useTrailRestore } from "@/features/change-trail/trail-change-recovery";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { formatRelativeTime } from "@/lib/date-groups";
import { displayThreadTitle } from "@/lib/thread-title";

export type PeerMarkPopoverTarget = {
  marker: SessionMarker;
  element: HTMLElement;
  activation: "pointer" | "keyboard";
  editorSelection: { from: number; to: number };
};

export function PeerMarkPopover({
  target,
  onOpenChange,
}: {
  target: PeerMarkPopoverTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const marker = target?.marker ?? null;
  const agentAuthor = marker?.author.kind === "agent" ? marker.author : null;
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: changeTrailDetailKey(agentAuthor?.threadId ?? "", marker?.group.trailId ?? ""),
    queryFn: () => readChangeTrail(agentAuthor?.threadId ?? "", marker?.group.trailId ?? ""),
    enabled: Boolean(marker && agentAuthor),
    staleTime: 0,
    gcTime: 0,
  });
  const snapshot = useQuery({
    queryKey: agentAuthor ? threadQueryKeys.snapshot(agentAuthor.threadId) : ["peer-mark-writer"],
    queryFn: async () =>
      deserializeThreadSnapshot(
        await getThreadSnapshot({ data: { threadId: agentAuthor?.threadId ?? "" } }),
      ),
    enabled: Boolean(agentAuthor),
    staleTime: 30_000,
  });
  const change = useMemo(() => {
    const document = detail.data?.find(
      (candidate) => candidate.documentId === marker?.group.documentId,
    );
    if (!document || "unavailable" in document) return null;
    return document.changes.find((candidate) => candidate.changeId === marker?.changeId) ?? null;
  }, [detail.data, marker]);
  const recovery = useTrailRestore({
    threadId: agentAuthor?.threadId ?? "",
    trailId: marker?.group.trailId ?? "",
    documentId: marker?.group.documentId ?? "",
    change,
  });
  const [copyReceipt, setCopyReceipt] = useState<{
    changeId: string;
    state: "copied" | "failed";
  } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copyState =
    copyReceipt && copyReceipt.changeId === marker?.changeId ? copyReceipt.state : "idle";
  const requestSnippet = useMemo(
    () => originatingRequestSnippet(snapshot.data?.turns ?? [], agentAuthor?.turnId ?? null),
    [agentAuthor?.turnId, snapshot.data?.turns],
  );
  const virtualAnchor = useRef({
    getBoundingClientRect: () => target?.element.getBoundingClientRect() ?? new DOMRect(),
  });
  virtualAnchor.current.getBoundingClientRect = () =>
    target?.element.getBoundingClientRect() ?? new DOMRect();

  useEffect(() => {
    if (!marker || !agentAuthor) return;
    const queryKey = changeTrailDetailKey(agentAuthor.threadId, marker.group.trailId);
    const evict = () => {
      void queryClient.removeQueries({ queryKey });
    };
    const unsubscribe = getDocumentSessionRegistry().observe(
      marker.group.documentId,
      (document) => {
        if (document.status === "access-lost") evict();
      },
    );
    return () => {
      unsubscribe();
      evict();
    };
  }, [agentAuthor, marker, queryClient]);

  if (!marker || !target) return null;
  const currentMarker = marker;
  const colorIdentity =
    marker.author.kind === "agent" ? marker.author.threadId : `writer:${marker.author.userId}`;
  const title =
    marker.author.kind === "agent"
      ? snapshot.data?.thread.title?.trim()
        ? displayThreadTitle(snapshot.data.thread.title)
        : t`AI assistant`
      : t`Collaborator`;
  const removedText = change ? recovery.body : marker.excerpt;
  const hasRemovedPassage = removedText !== null && markerLabelKind(marker) !== "insert";
  const hasDisclosure =
    Boolean(agentAuthor) &&
    (marker.swept || markerLabelKind(marker) !== "insert" || requestSnippet !== null);
  const relativeTime = formatRelativeTime(new Date(marker.receivedAt), Date.now());

  function openConversation(): void {
    if (!agentAuthor) return;
    requestConversationReveal({
      threadId: agentAuthor.threadId,
      turnId: agentAuthor.turnId,
      changeId: currentMarker.changeId,
    });
    onOpenChange(false);
  }

  async function copyRecoveryBody(): Promise<void> {
    if (removedText === null) return;
    const changeId = currentMarker.changeId;
    setCopyReceipt(null);
    try {
      await navigator.clipboard.writeText(removedText);
      setCopyReceipt({ changeId, state: "copied" });
    } catch {
      setCopyReceipt({ changeId, state: "failed" });
    }
  }

  return (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-80 space-y-3 p-3 text-caption"
        data-peer-mark-popover
        onOpenAutoFocus={(event) => {
          if (target.activation === "pointer") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // The virtual anchor cannot restore focus correctly. EditorView owns
          // activation-aware restoration after this controlled popover closes.
          event.preventDefault();
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: collaborationColorFor(colorIdentity) }}
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate font-medium text-prose-foreground">{title}</p>
          <time
            className="shrink-0 text-ink-muted"
            role="timer"
            aria-label={t`Changed ${relativeTime}`}
            dateTime={new Date(marker.receivedAt).toISOString()}
          >
            {relativeTime}
          </time>
        </div>

        {agentAuthor ? (
          <>
            <p className="text-ink-muted">{markerLabel(marker)}</p>
            {hasDisclosure ? (
              <div className="border-border-subtle border-y py-1">
                <button
                  type="button"
                  className="focus-ring flex w-full items-center justify-between rounded-sm px-1 py-1 text-ink-muted hover:text-prose-foreground"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  {detailsOpen ? <Trans>Hide details</Trans> : <Trans>Show details</Trans>}
                  <ChevronRight
                    className={`size-3.5 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
                    aria-hidden
                  />
                </button>
                {detailsOpen ? (
                  <div className="space-y-3 px-1 pt-2 pb-1">
                    {marker.swept ? (
                      <p className="text-caption text-prose-foreground">
                        <Trans>This passage included edits you made that the AI hadn't seen.</Trans>
                      </p>
                    ) : null}
                    {hasRemovedPassage ? (
                      <RemovedText
                        text={removedText}
                        copyState={copyState}
                        onCopy={() => void copyRecoveryBody()}
                      />
                    ) : null}
                    {requestSnippet ? (
                      <div>
                        <p className="font-medium text-ink-muted text-micro uppercase tracking-wide">
                          <Trans>You asked</Trans>
                        </p>
                        <p className="truncate text-prose-foreground">{requestSnippet}</p>
                      </div>
                    ) : null}
                    {detail.isPending ? (
                      <p className="text-ink-muted">
                        <Trans>Loading change details…</Trans>
                      </p>
                    ) : detail.isError ? (
                      <p className="text-ink-muted">
                        <Trans>Change details are unavailable.</Trans>
                      </p>
                    ) : !change ? (
                      <p className="text-ink-muted">
                        <Trans>This change is no longer in the trail.</Trans>
                      </p>
                    ) : null}
                    {copyState === "failed" ? (
                      <p className="text-destructive">
                        <Trans>Couldn't copy. Select the saved text and copy it manually.</Trans>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center gap-2 border-border-subtle border-t pt-3">
              {recovery.canExecute ? (
                <Button
                  size="sm"
                  disabled={recovery.isPending}
                  onClick={() => void recovery.execute()}
                >
                  <Trans>Restore</Trans>
                </Button>
              ) : null}
              {recovery.applied ? (
                <span className="text-jade-text">
                  <Trans>Restored</Trans>
                </span>
              ) : null}
              <Button size="sm" variant="quiet" className="ml-auto" onClick={openConversation}>
                <Trans>Open conversation</Trans>
              </Button>
            </div>
            {recovery.failed ? (
              <p className="text-destructive">
                <Trans>Couldn't apply that recovery action. Try again.</Trans>
              </p>
            ) : null}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function RemovedText({
  text,
  copyState,
  onCopy,
}: {
  text: string;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-ink-muted text-micro uppercase tracking-wide">
          <Trans>Removed passage</Trans>
        </p>
        <Button size="meta" variant="quiet" onClick={onCopy}>
          {copyState === "copied" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
        </Button>
      </div>
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-subtle p-2 text-prose-foreground">
        {text}
      </p>
    </div>
  );
}

function markerLabel(marker: SessionMarker): string {
  return changeKindLabel(markerLabelKind(marker));
}

function markerLabelKind(marker: SessionMarker): SessionMarker["kind"] {
  return marker.kind === "modify" && marker.pureDeletionOffset !== null ? "delete" : marker.kind;
}

function originatingRequestSnippet(
  turns: readonly {
    id: string;
    role: string;
    blocks: readonly { blockType: string; textContent?: string | null }[];
  }[],
  turnId: string | null,
): string | null {
  if (!turnId) return null;
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  for (let index = turnIndex - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn?.role !== "user") continue;
    return (
      turn.blocks.find((block) => block.blockType === "text")?.textContent ??
      turn.blocks[0]?.textContent ??
      null
    );
  }
  return null;
}
