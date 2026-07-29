/**
 * Anchored evidence and navigation for one session peer mark.
 *
 * **Elements are geometry, holds are identity.** The mark is a decoration, and
 * the plugin drawing it rebuilds every decoration on every remote write, so the
 * span the writer clicked is gone the moment a collaborator types. What the
 * popover holds is the mark itself — a `changeId` whose anchor is a relative
 * position — and it asks the page for the current span on every rect it needs. A
 * captured span measures as a rect of zeros, which puts the popover in the
 * corner of the window with its arm pointing at nothing.
 *
 * The Radix root is `EditorPopover`, like every other summoned surface: the
 * kernel then knows this is the open transient, so Mod+K replaces it instead of
 * leaving two surfaces claiming the same keystrokes, and Escape has one owner.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { bodyFromTrailHashline, changeTrailDetailKey } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { collaborationColorFor } from "@/core/editor/collaboration-colors";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { peerMarkRect } from "@/core/editor/extensions/PeerMarkerExtension";
import type { PeerMarkPress } from "@/core/editor/extensions/peer-mark-press";
import type { SessionMarker } from "@/core/editor/session-marker-store";
import { changeTrailDetailQuery } from "@/features/change-trail/trail-detail-query";
import { ChangeExcerpts } from "@/features/chat/ChangeViewRows";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { formatRelativeTime } from "@/lib/date-groups";

import { EditorPopover } from "../../chrome";

/** The press, plus the mark as the store reports it right now. */
export type PeerMarkPopoverTarget = PeerMarkPress & { marker: SessionMarker };

export function PeerMarkPopover({
  editor,
  target,
  onOpenChange,
  returnFocus,
}: {
  editor: Editor | null;
  target: PeerMarkPopoverTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close, when nothing took this popover's place. */
  returnFocus?: () => void;
}) {
  const marker = target?.marker ?? null;
  const agentAuthor = marker?.author.kind === "agent" ? marker.author : null;
  const queryClient = useQueryClient();
  const detail = useQuery({
    ...changeTrailDetailQuery(agentAuthor?.threadId ?? "", marker?.group.trailId ?? ""),
    enabled: Boolean(marker && agentAuthor),
  });
  const change = useMemo(() => {
    const document = detail.data?.find(
      (candidate) => candidate.documentId === marker?.group.documentId,
    );
    if (!document || "unavailable" in document) return null;
    return document.changes.find((candidate) => candidate.changeId === marker?.changeId) ?? null;
  }, [detail.data, marker]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const changeId = target?.changeId ?? null;

  // Losing access to the document is the only reason to drop cached evidence
  // while the popover is open; closing it is not, or every open refetches.
  useEffect(() => {
    if (!marker || !agentAuthor) return;
    const queryKey = changeTrailDetailKey(agentAuthor.threadId, marker.group.trailId);
    return getDocumentSessionRegistry().observe(marker.group.documentId, (document) => {
      if (document.status === "access-lost") void queryClient.removeQueries({ queryKey });
    });
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
    // A change row lives inside a turn's receipt, so an authorless-of-turn mark
    // can only ask for the conversation itself.
    requestConversationReveal(
      agentAuthor.turnId === null
        ? { kind: "thread", threadId: agentAuthor.threadId }
        : {
            kind: "change",
            threadId: agentAuthor.threadId,
            turnId: agentAuthor.turnId,
            changeId: currentMarker.changeId,
          },
    );
    onOpenChange(false);
  }

  return (
    <EditorPopover
      editor={editor}
      id="peer-mark"
      open
      onOpenChange={onOpenChange}
      // Asked on every measurement rather than captured once: floating-ui calls
      // this again on scroll, on resize, and on every reposition, and the span
      // answering it is whichever one is drawing the mark at that moment.
      anchorRect={() => peerMarkRect(editor, changeId)}
      align="start"
      // A pointer press already left the caret in the sentence the writer was
      // reading; only the keyboard door asks to be taken inside.
      focusOnOpen={target.activation === "pointer" ? "prose" : "content"}
      returnFocus={returnFocus}
      className="w-80 text-caption"
    >
      <div className="space-y-3" data-peer-mark-popover>
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

        {agentAuthor && !detail.isPending ? (
          <>
            {detailsOpen && change ? (
              <div className="border-border-subtle border-t pt-3">
                <ChangeExcerpts change={change} />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-border-subtle border-t pt-3">
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
              <Button size="sm" variant="quiet" className="ml-auto" onClick={openConversation}>
                <Trans>Open conversation</Trans>
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </EditorPopover>
  );
}
