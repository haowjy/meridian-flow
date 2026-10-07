/**
 * The small pieces every surface that shows a change shares: its colour dot,
 * who made it, and why a command on it did not land. The row, the bar and the
 * phone's sheet are made of these, so a change reads the same everywhere.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";

import type { ChangeCommandMode, ChangeFailureCode } from "@/client/query/change-command-record";
import { useOpenChatThread } from "@/features/chat/ChatThreadNavigation";
import { cn } from "@/lib/utils";
import type { ChangeAttribution } from "./change-attribution";
import type { ReviewChange, ReviewChangeTone } from "./review-changes";

const DOT_TONE: Record<ReviewChangeTone, string> = {
  ai: "bg-primary",
  writer: "bg-gold",
  removal: "bg-destructive",
  merged: "bg-muted-foreground",
};

/** A dot in the change's colour. Half green, half gold when the writer's edits are inside an AI change. */
export function ChangeDot({ change, className }: { change: ReviewChange; className?: string }) {
  const half = change.includesWriterEdits && change.tone === "ai";
  return (
    <span
      aria-hidden
      data-tone={change.tone}
      className={cn(
        "size-2 shrink-0 rounded-full",
        half
          ? "bg-[linear-gradient(90deg,var(--color-primary)_50%,var(--color-gold)_50%)]"
          : DOT_TONE[change.tone],
        className,
      )}
    />
  );
}

/**
 * "You", a link that opens the chat that wrote the change, or plain "AI" when
 * the preview cannot say which chat. The link never also acts on the change.
 */
export function ChangeAuthor({
  attribution,
  className,
}: {
  attribution: ChangeAttribution;
  className?: string;
}) {
  const openThread = useOpenChatThread();
  if (attribution.kind === "you") {
    return (
      <span
        className={cn(
          "shrink-0 text-caption font-medium text-[color:var(--color-review-writer-removed-foreground)]",
          className,
        )}
      >
        <Trans>You</Trans>
      </span>
    );
  }
  if (attribution.kind === "ai" || !openThread) {
    return (
      <span className={cn("shrink-0 text-caption text-muted-foreground", className)}>
        <Trans>AI</Trans>
      </span>
    );
  }
  const title = attribution.title?.trim() || t`AI`;
  return (
    <button
      type="button"
      title={t`Open the chat that wrote this change`}
      onClick={(event) => {
        event.stopPropagation();
        openThread(attribution.threadId);
      }}
      className={cn(
        "focus-ring inline-flex min-w-0 max-w-32 items-center gap-0.5 rounded-sm text-caption text-primary hover:underline",
        className,
      )}
    >
      <span className="truncate">{title}</span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/** Why a command on a change did not land, in the writer's words. */
export function ChangeFailureText({
  code,
  mode,
}: {
  code: ChangeFailureCode;
  mode: ChangeCommandMode;
}) {
  switch (code) {
    case "stale":
      return <Trans>This change was updated. Check it and apply again.</Trans>;
    case "gone":
      return <Trans>That change is no longer in the draft.</Trans>;
    case "draft-only":
      return <Trans>A new document is applied as a whole. Use Apply draft.</Trans>;
    case "offline":
      return mode === "apply" ? (
        <Trans>Couldn't apply. Check your connection and try again.</Trans>
      ) : (
        <Trans>Couldn't discard. Check your connection and try again.</Trans>
      );
  }
}

/** The Discard button's name: it never hides that the writer's own edits go with it. */
export function discardLabel(change: ReviewChange): string {
  return change.includesWriterEdits ? t`Discard with your edits` : t`Discard`;
}
