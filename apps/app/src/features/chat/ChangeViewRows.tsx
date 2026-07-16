/** Writer-protection rows inside the existing per-turn Changes view. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { TrailForwardAction, TrailForwardActionStateV1 } from "@meridian/contracts";
import { useRef, useState } from "react";
import { applyTrailForwardAction, type TrailChange } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

/** The open wording veto lives here: changing this one key changes every sweep row. */
export const sweepWarningText = () =>
  t`Removed a passage that included words the agent hadn't seen.`;

export function ChangeViewRows({
  threadId,
  trailId,
  documentId,
  changes,
  navigateToChange,
  runAction = applyTrailForwardAction,
  copyText = copyToClipboard,
  anchorUnavailable = false,
}: {
  threadId: string;
  trailId: string;
  documentId: string;
  changes: TrailChange[];
  navigateToChange: NavigateToTrailChange;
  runAction?: typeof applyTrailForwardAction;
  copyText?: (text: string) => Promise<void>;
  anchorUnavailable?: boolean;
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
}: {
  threadId: string;
  trailId: string;
  documentId: string;
  change: TrailChange;
  navigateToChange: NavigateToTrailChange;
  runAction: typeof applyTrailForwardAction;
  copyText: (text: string) => Promise<void>;
  anchorUnavailable: boolean;
}) {
  const protection = protectionFor(change);
  const action = protection?.kind === "resurrection" ? "delete-again" : "restore";
  const durableActionState: TrailForwardActionStateV1 | undefined = change.forwardActions?.[action];
  const hasCanonicalRestoreAnchor =
    action === "restore" &&
    change.navigation.kind === "unavailable" &&
    change.afterBlockIdentity?.documentId === change.documentId;
  const [navigation, setNavigation] = useState<TrailNavigationResult | null>(null);
  const [actionState, setActionState] = useState<"idle" | "pending" | "applied">(
    durableActionState?.status === "applied" ? "applied" : "idle",
  );
  const [anchorUnavailable, setAnchorUnavailable] = useState(
    durableActionState?.status === "settled" ||
      (!durableActionState &&
        (initiallyUnavailable ||
          (change.navigation.kind === "unavailable" && !hasCanonicalRestoreAnchor))),
  );
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const actionRequest = useRef<Promise<void> | null>(null);
  const protectedBody = protection?.body.status === "available" ? protection.body.markdown : null;
  const body = protectedBody ?? (anchorUnavailable ? bodyFromHashline(change.beforeText) : null);

  async function reveal() {
    const result = await navigateToChange(documentId, change);
    setNavigation(result);
    if (result.kind === "unavailable" && !hasCanonicalRestoreAnchor) setAnchorUnavailable(true);
  }

  async function forward(action: TrailForwardAction) {
    if (actionState !== "idle" || actionRequest.current) return;
    setActionState("pending");
    setRestoreFailed(false);
    const request = runAction({ threadId, trailId, changeId: change.changeId, action })
      .then((result) => {
        if (result.status === "anchor_unavailable") {
          setAnchorUnavailable(true);
          setActionState("idle");
          return;
        }
        if (result.status === "retry_exhausted") {
          setRestoreFailed(true);
          setActionState("idle");
          return;
        }
        setActionState("applied");
      })
      .catch(() => {
        setRestoreFailed(true);
        setActionState("idle");
      })
      .finally(() => {
        actionRequest.current = null;
      });
    actionRequest.current = request;
    await request;
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
      className="space-y-1.5 rounded-md bg-surface-subtle p-2 text-caption"
      data-change-view-row={protection?.kind ?? change.kind}
    >
      <button
        type="button"
        className="focus-ring text-left font-medium text-prose-foreground"
        onClick={() => void reveal()}
      >
        {protection?.kind === "resurrection" ? (
          <Trans>↻ AI brought back text you deleted</Trans>
        ) : protection?.kind === "sweep" ? (
          sweepWarningText()
        ) : change.kind === "insert" ? (
          <Trans>AI added text</Trans>
        ) : change.kind === "modify" ? (
          <Trans>AI changed text</Trans>
        ) : (
          <Trans>AI deleted text</Trans>
        )}
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
      {restoreFailed ? (
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
          {anchorUnavailable || (restoreFailed && action === "restore") ? (
            <Button size="sm" onClick={() => void copy(body)}>
              <Trans>Copy</Trans>
            </Button>
          ) : null}
          {!anchorUnavailable && actionState !== "applied" ? (
            <Button
              size="sm"
              disabled={actionState !== "idle"}
              onClick={() => void forward(action)}
            >
              {action === "delete-again" ? <Trans>Delete again</Trans> : <Trans>Restore</Trans>}
            </Button>
          ) : null}
          {actionState === "applied" ? (
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

function bodyFromHashline(serialized: string | null): string | null {
  if (serialized === null) return null;
  const separator = serialized.indexOf("|");
  return separator < 0 ? serialized : serialized.slice(separator + 1);
}

function protectionFor(change: TrailChange): TrailChange["writerProtection"] {
  if (change.writerProtection) return change.writerProtection;
  return change.swept ? { kind: "sweep", body: change.swept.removed } : undefined;
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
