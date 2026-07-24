/** Anchored detail and recovery surface for one session peer mark. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { changeTrailDetailKey, readChangeTrail } from "@/client/change-trails";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { changeMarkLabel } from "@/core/editor/change-mark-labels";
import { collaborationColorFor } from "@/core/editor/collaboration-colors";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { SessionMarker } from "@/core/editor/session-marker-store";
import {
  trailChangeLabel,
  useTrailForwardAction,
} from "@/features/change-trail/trail-change-recovery";
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
  const change = useMemo(
    () =>
      detail.data
        ?.find((document) => document.documentId === marker?.group.documentId)
        ?.changes?.find((candidate) => candidate.changeId === marker?.changeId) ?? null,
    [detail.data, marker],
  );
  const recovery = useTrailForwardAction({
    threadId: agentAuthor?.threadId ?? "",
    trailId: marker?.group.trailId ?? "",
    documentId: marker?.group.documentId ?? "",
    change,
  });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
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
      ? displayThreadTitle(snapshot.data?.thread.title)
      : t`Collaborator`;
  const removedText = change ? recovery.body : marker.excerpt;

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
    if (!recovery.body) return;
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(recovery.body);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
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
        <div className="flex items-start gap-2">
          <span
            className="mt-1 size-2 shrink-0 rounded-full"
            style={{ background: collaborationColorFor(colorIdentity) }}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-prose-foreground">{title}</p>
            {marker.author.kind === "agent" ? (
              <p className="text-ink-muted">
                {change ? trailChangeLabel(change) : markerLabel(marker)}
                <span aria-hidden> · </span>
                {formatRelativeTime(new Date(marker.receivedAt), Date.now())}
              </p>
            ) : (
              <p className="text-ink-muted">
                {formatRelativeTime(new Date(marker.receivedAt), Date.now())}
              </p>
            )}
          </div>
        </div>

        {agentAuthor ? (
          detail.isPending ? (
            marker.kind === "delete" && marker.excerpt ? (
              <RemovedText text={marker.excerpt} />
            ) : (
              <p className="text-ink-muted">
                <Trans>Loading change details…</Trans>
              </p>
            )
          ) : detail.isError ? (
            <p className="text-ink-muted">
              <Trans>Change details are unavailable.</Trans>
            </p>
          ) : !change ? (
            <p className="text-ink-muted">
              <Trans>This change is no longer in the trail.</Trans>
            </p>
          ) : (
            <>
              {removedText && change.kind !== "insert" ? <RemovedText text={removedText} /> : null}
              {requestSnippet ? (
                <div>
                  <p className="font-medium text-ink-muted">
                    <Trans>Request</Trans>
                  </p>
                  <p className="truncate text-prose-foreground">{requestSnippet}</p>
                </div>
              ) : null}
            </>
          )
        ) : null}

        {agentAuthor ? (
          <div className="flex items-center gap-2 border-border-subtle border-t pt-3">
            {recovery.canCopy && recovery.body ? (
              <Button size="sm" onClick={() => void copyRecoveryBody()}>
                <Trans>Copy</Trans>
              </Button>
            ) : null}
            {recovery.canExecute ? (
              <Button
                size="sm"
                disabled={recovery.isPending}
                onClick={() => void recovery.execute()}
              >
                {recovery.action === "delete-again" ? (
                  <Trans>Delete again</Trans>
                ) : (
                  <Trans>Restore</Trans>
                )}
              </Button>
            ) : null}
            {recovery.applied ? (
              <span className="text-jade-text">
                {recovery.action === "delete-again" ? (
                  <Trans>Deleted again</Trans>
                ) : (
                  <Trans>Restored</Trans>
                )}
              </span>
            ) : null}
            {copyState === "copied" ? (
              <span className="text-jade-text">
                <Trans>Copied</Trans>
              </span>
            ) : null}
            <Button size="sm" variant="quiet" onClick={openConversation}>
              <Trans>Open conversation</Trans>
            </Button>
          </div>
        ) : null}
        {recovery.failed ? (
          <p className="text-destructive">
            <Trans>Couldn't apply that recovery action. Try again.</Trans>
          </p>
        ) : null}
        {copyState === "failed" ? (
          <p className="text-destructive">
            <Trans>Couldn't copy. Select the saved text and copy it manually.</Trans>
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function RemovedText({ text }: { text: string }) {
  return (
    <div className="max-h-32 overflow-y-auto rounded-md bg-surface-subtle p-2">
      <p className="whitespace-pre-wrap text-ink-muted line-through">{text}</p>
    </div>
  );
}

function markerLabel(marker: SessionMarker): string {
  return changeMarkLabel(marker.kind, marker.pureDeletionOffset);
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
