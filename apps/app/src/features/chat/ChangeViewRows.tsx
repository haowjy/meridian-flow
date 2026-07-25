/** Read-only before/after rows for one durable turn receipt. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { useEffect, useRef, useState } from "react";
import { bodyFromTrailHashline } from "@/client/change-trails";
import { changeKindLabel } from "@/core/editor/change-mark-labels";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import { type ConversationReveal, completeConversationReveal } from "./conversation-reveal";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export function ChangeViewRows({
  documentId,
  changes,
  navigateToChange,
  anchorUnavailable = false,
  reveal = null,
}: {
  documentId: string;
  changes: TrailChange[];
  navigateToChange: NavigateToTrailChange;
  anchorUnavailable?: boolean;
  reveal?: ConversationReveal | null;
}) {
  return (
    <div className="px-3 pb-2 pl-9">
      <ol className="space-y-2">
        {[...changes]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((change) => (
            <ChangeViewRow
              key={change.changeId}
              documentId={documentId}
              change={change}
              navigateToChange={navigateToChange}
              anchorUnavailable={anchorUnavailable}
              reveal={reveal}
            />
          ))}
      </ol>
    </div>
  );
}

function ChangeViewRow({
  documentId,
  change,
  navigateToChange,
  anchorUnavailable,
  reveal,
}: {
  documentId: string;
  change: TrailChange;
  navigateToChange: NavigateToTrailChange;
  anchorUnavailable: boolean;
  reveal: ConversationReveal | null;
}) {
  const [navigation, setNavigation] = useState<TrailNavigationResult | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (reveal?.changeId !== change.changeId) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
    completeConversationReveal(reveal);
  }, [change.changeId, reveal]);

  async function revealInEditor() {
    setNavigation(await navigateToChange(documentId, change));
  }

  return (
    <li ref={rowRef} className="space-y-2 py-2 text-caption" data-change-view-row={change.kind}>
      <button
        type="button"
        className="focus-ring rounded-sm text-left font-medium text-prose-foreground"
        onClick={() => void revealInEditor()}
      >
        {changeKindLabel(change.kind)}
      </button>
      {anchorUnavailable ? (
        <p className="text-ink-muted">
          <Trans>This chapter is no longer available. The saved excerpts remain below.</Trans>
        </p>
      ) : navigation?.kind === "could_not_open" || navigation?.kind === "unavailable" ? (
        <p className="text-ink-muted">
          <Trans>That part of the chapter is no longer available.</Trans>
        </p>
      ) : null}
      <ChangeExcerpts change={change} />
    </li>
  );
}

/** The one trail-backed Before/After renderer used by receipts and live marks. */
export function ChangeExcerpts({ change }: { change: TrailChange }) {
  const before = bodyFromTrailHashline(change.beforeText);
  const after = bodyFromTrailHashline(change.afterTextAtReceipt);

  return (
    <div className="space-y-1">
      {before !== null ? (
        <p
          data-change-excerpt="before"
          className="line-clamp-3 whitespace-pre-wrap break-words text-ink-muted"
        >
          <span className="sr-only">{t`Before`}: </span>
          <del className="no-underline">{before || "\u00a0"}</del>
        </p>
      ) : null}
      {after !== null ? (
        <p
          data-change-excerpt="after"
          className="line-clamp-3 whitespace-pre-wrap break-words text-prose-foreground"
        >
          <span className="sr-only">{t`After`}: </span>
          <ins className="no-underline">{after || "\u00a0"}</ins>
        </p>
      ) : null}
    </div>
  );
}
