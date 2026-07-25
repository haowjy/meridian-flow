/** Anchored detail and recovery surface for one session peer mark. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  bodyFromTrailHashline,
  changeTrailDetailKey,
  readChangeTrail,
} from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { collaborationColorFor } from "@/core/editor/collaboration-colors";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { SessionMarker } from "@/core/editor/session-marker-store";
import { useTrailRestore } from "@/features/change-trail/trail-change-recovery";
import { ChangeExcerpts } from "@/features/chat/ChangeViewRows";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { formatRelativeTime } from "@/lib/date-groups";

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
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  const title = marker.author.kind === "agent" ? t`AI assistant` : t`Collaborator`;
  const hasDiff =
    change !== null &&
    (bodyFromTrailHashline(change.beforeText) !== null ||
      bodyFromTrailHashline(change.afterTextAtReceipt) !== null);
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
            {detailsOpen && change ? (
              <div className="border-border-subtle border-t pt-3">
                <ChangeExcerpts change={change} />
              </div>
            ) : null}

            <div className="flex items-center gap-2 border-border-subtle border-t pt-3">
              {hasDiff ? (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  <Trans>Before</Trans> / <Trans>After</Trans>
                  <ChevronRight
                    className={`size-3.5 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
                    aria-hidden
                  />
                </Button>
              ) : null}
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
