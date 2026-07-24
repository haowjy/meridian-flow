/** Peer-edit rows with recovery actions inside the existing per-turn Changes view. */
import { Trans } from "@lingui/react/macro";
import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { useEffect, useRef, useState } from "react";
import { applyTrailForwardAction } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import {
  trailChangeLabel,
  useTrailForwardAction,
} from "@/features/change-trail/trail-change-recovery";
import { type ConversationReveal, completeConversationReveal } from "./conversation-reveal";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export function ChangeViewRows({
  threadId,
  trailId,
  documentId,
  changes,
  navigateToChange,
  runAction = applyTrailForwardAction,
  copyText = copyToClipboard,
  anchorUnavailable = false,
  reveal = null,
}: {
  threadId: string;
  trailId: string;
  documentId: string;
  changes: TrailChange[];
  navigateToChange: NavigateToTrailChange;
  runAction?: typeof applyTrailForwardAction;
  copyText?: (text: string) => Promise<void>;
  anchorUnavailable?: boolean;
  reveal?: ConversationReveal | null;
}) {
  return (
    <ol className="space-y-2 px-3 pb-2 pl-9">
      {[...changes]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((change) => (
          <ChangeViewRow
            key={change.changeId}
            threadId={threadId}
            trailId={trailId}
            documentId={documentId}
            change={change}
            navigateToChange={navigateToChange}
            runAction={runAction}
            copyText={copyText}
            anchorUnavailable={anchorUnavailable}
            emphasized={reveal?.changeId === change.changeId}
            reveal={reveal}
          />
        ))}
    </ol>
  );
}

function ChangeViewRow({
  threadId,
  trailId,
  documentId,
  change,
  navigateToChange,
  runAction,
  copyText,
  anchorUnavailable: initiallyUnavailable,
  emphasized: shouldEmphasize,
  reveal: conversationReveal,
}: {
  threadId: string;
  trailId: string;
  documentId: string;
  change: TrailChange;
  navigateToChange: NavigateToTrailChange;
  runAction: typeof applyTrailForwardAction;
  copyText: (text: string) => Promise<void>;
  anchorUnavailable: boolean;
  emphasized: boolean;
  reveal: ConversationReveal | null;
}) {
  const recovery = useTrailForwardAction({
    threadId,
    trailId,
    documentId,
    change,
    runAction,
  });
  const { action, protection } = recovery;
  const hasCanonicalRestoreAnchor =
    action === "restore" &&
    change.navigation.kind === "unavailable" &&
    change.afterBlockIdentity?.documentId === change.documentId;
  const [navigation, setNavigation] = useState<TrailNavigationResult | null>(null);
  const [locallyUnavailable, setLocallyUnavailable] = useState(
    !recovery.durableState &&
      (initiallyUnavailable ||
        (change.navigation.kind === "unavailable" && !hasCanonicalRestoreAnchor)),
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const rowRef = useRef<HTMLLIElement>(null);
  const [emphasized, setEmphasized] = useState(shouldEmphasize);
  const anchorUnavailable = recovery.anchorUnavailable || locallyUnavailable;
  const body = protection || anchorUnavailable ? recovery.body : null;
  const canCopy = recovery.canCopy || locallyUnavailable;

  useEffect(() => {
    if (!shouldEmphasize || !conversationReveal) return;
    setEmphasized(true);
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    completeConversationReveal(conversationReveal);
  }, [conversationReveal, shouldEmphasize]);

  async function revealInEditor() {
    const result = await navigateToChange(documentId, change);
    setNavigation(result);
    if (result.kind === "unavailable" && !hasCanonicalRestoreAnchor) setLocallyUnavailable(true);
  }

  async function copy(body: string) {
    setCopyState("idle");
    try {
      await copyText(body);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <li
      ref={rowRef}
      className={`space-y-1.5 rounded-md bg-surface-subtle p-2 text-caption ${
        emphasized ? "meridian-trail-row-emphasized" : ""
      }`}
      data-change-view-row={protection?.kind ?? change.kind}
      onPointerDown={() => setEmphasized(false)}
      onKeyDown={() => setEmphasized(false)}
    >
      <button
        type="button"
        className="focus-ring text-left font-medium text-prose-foreground"
        onClick={() => void revealInEditor()}
      >
        {trailChangeLabel(change)}
      </button>
      {body ? <p className="whitespace-pre-wrap text-prose-foreground">{body}</p> : null}
      {protection && !body ? (
        <p className="text-ink-muted">
          <Trans>Earlier content could not be recovered</Trans>
        </p>
      ) : null}
      {navigation?.kind === "could_not_open" ? (
        <p className="text-ink-muted">
          <Trans>That part of the chapter is no longer available. Copy the saved text below.</Trans>
        </p>
      ) : null}
      {anchorUnavailable && body ? (
        <p className="text-ink-muted">
          <Trans>This passage can't be restored in place. Copy it instead.</Trans>
        </p>
      ) : null}
      {recovery.failed ? (
        <p className="text-destructive">
          {action === "restore" ? (
            <Trans>Couldn't restore the passage. Try again, or copy it instead.</Trans>
          ) : (
            <Trans>Couldn't delete the passage again. Try again.</Trans>
          )}
        </p>
      ) : null}
      {body && (protection || anchorUnavailable) ? (
        <div className="flex items-center gap-2">
          {canCopy || (recovery.failed && action === "restore") ? (
            <Button size="sm" onClick={() => void copy(body)}>
              <Trans>Copy</Trans>
            </Button>
          ) : null}
          {recovery.canExecute && !anchorUnavailable ? (
            <Button size="sm" disabled={recovery.isPending} onClick={() => void recovery.execute()}>
              {action === "delete-again" ? <Trans>Delete again</Trans> : <Trans>Restore</Trans>}
            </Button>
          ) : null}
          {recovery.applied ? (
            <span className="text-jade-text">
              {action === "delete-again" ? <Trans>Deleted again</Trans> : <Trans>Restored</Trans>}
            </span>
          ) : null}
          {copyState === "copied" ? (
            <span className="text-jade-text">
              <Trans>Copied</Trans>
            </span>
          ) : null}
        </div>
      ) : null}
      {copyState === "failed" ? (
        <p className="text-destructive">
          <Trans>Couldn't copy. Select the saved text and copy it manually.</Trans>
        </p>
      ) : null}
    </li>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
