/** Read-only before/after rows for one durable turn receipt. */
import { Trans } from "@lingui/react/macro";
import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { useEffect, useRef, useState } from "react";
import { bodyFromTrailHashline } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { changeKindLabel } from "@/core/editor/change-mark-labels";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import { type ConversationReveal, completeConversationReveal } from "./conversation-reveal";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export function ChangeViewRows({
  documentId,
  changes,
  navigateToChange,
  copyText = copyToClipboard,
  anchorUnavailable = false,
  reveal = null,
}: {
  documentId: string;
  changes: TrailChange[];
  navigateToChange: NavigateToTrailChange;
  copyText?: (text: string) => Promise<void>;
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
              copyText={copyText}
              anchorUnavailable={anchorUnavailable}
              emphasized={reveal?.changeId === change.changeId}
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
  copyText,
  anchorUnavailable,
  emphasized: shouldEmphasize,
  reveal,
}: {
  documentId: string;
  change: TrailChange;
  navigateToChange: NavigateToTrailChange;
  copyText: (text: string) => Promise<void>;
  anchorUnavailable: boolean;
  emphasized: boolean;
  reveal: ConversationReveal | null;
}) {
  const [navigation, setNavigation] = useState<TrailNavigationResult | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const rowRef = useRef<HTMLLIElement>(null);
  const [emphasized, setEmphasized] = useState(shouldEmphasize);
  const before = bodyFromTrailHashline(change.beforeText);
  const after = bodyFromTrailHashline(change.afterTextAtReceipt);

  useEffect(() => {
    if (!shouldEmphasize || !reveal) return;
    setEmphasized(true);
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    completeConversationReveal(reveal);
  }, [reveal, shouldEmphasize]);

  async function revealInEditor() {
    setNavigation(await navigateToChange(documentId, change));
  }

  async function copy(text: string) {
    setCopyState("idle");
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <li
      ref={rowRef}
      className={`space-y-2 rounded-md p-2 text-caption ${
        emphasized ? "meridian-trail-row-emphasized" : ""
      }`}
      data-change-view-row={change.kind}
      onPointerDown={() => setEmphasized(false)}
      onKeyDown={() => setEmphasized(false)}
    >
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
      {before !== null ? (
        <ExcerptBlock label="before" text={before} onCopy={() => void copy(before)} />
      ) : null}
      {after !== null ? <ExcerptBlock label="after" text={after} /> : null}
      {copyState === "copied" ? (
        <p className="text-jade-text">
          <Trans>Copied</Trans>
        </p>
      ) : copyState === "failed" ? (
        <p className="text-destructive">
          <Trans>Couldn't copy. Select the saved text and copy it manually.</Trans>
        </p>
      ) : null}
    </li>
  );
}

function ExcerptBlock({
  label,
  text,
  onCopy,
}: {
  label: "before" | "after";
  text: string;
  onCopy?: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-ink-muted text-micro uppercase tracking-wide">
          {label === "before" ? <Trans>Before</Trans> : <Trans>After</Trans>}
        </p>
        {onCopy ? (
          <Button type="button" variant="quiet" size="meta" onClick={onCopy}>
            <Trans>Copy</Trans>
          </Button>
        ) : null}
      </div>
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-subtle p-2 text-prose-foreground">
        {text}
      </p>
    </div>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
