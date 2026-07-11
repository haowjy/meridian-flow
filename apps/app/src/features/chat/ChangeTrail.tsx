/** Quiet per-turn trail disclosure and honest historical-change detail. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeTrailShell, TrailChange } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export function ChangeTrail({
  threadId,
  shell,
  gapPending = false,
  turnComplete = false,
  navigateToChange,
}: {
  threadId: string;
  shell: ChangeTrailShell;
  gapPending?: boolean;
  turnComplete?: boolean;
  navigateToChange: NavigateToTrailChange;
}) {
  const { detail, open, toggle, evict } = useAuthorizedChangeTrailDetail(threadId, shell);
  const settled = shell.state === "settled" && !gapPending;
  useEffect(() => {
    if (gapPending) evict();
  }, [evict, gapPending]);
  const finishing =
    shell.state === "settling" ||
    (turnComplete && shell.state === "building") ||
    (shell.state === "settled" && gapPending);
  return (
    <section
      className="mt-3 text-caption text-muted-foreground"
      data-change-trail-state={gapPending ? "reconciling" : shell.state}
    >
      <button
        type="button"
        disabled={!settled}
        onClick={settled ? toggle : undefined}
        aria-expanded={open}
        className="focus-ring flex items-center gap-1 disabled:cursor-default"
      >
        {finishing ? (
          <Trans>Finishing change record…</Trans>
        ) : (
          <Trans>
            Edited <Plural value={shell.changeCount} one="# place" other="# places" /> across{" "}
            <Plural value={shell.documentCount} one="# document" other="# documents" />
          </Trans>
        )}
        {settled ? <ChevronDownIcon className="size-3" aria-hidden="true" /> : null}
      </button>
      {shell.sweptChangeCount > 0 ? (
        <p>
          <Plural
            value={shell.sweptChangeCount}
            one="# touched your recent edits"
            other="# touched your recent edits"
          />
        </p>
      ) : null}
      {open && settled ? (
        <div className="mt-2 space-y-3 border-l border-border-subtle pl-3">
          {detail.isError ? (
            <div className="space-y-1">
              <p>
                <Trans>Couldn't load change details.</Trans>
              </p>
              <Button size="sm" onClick={() => void detail.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {detail.data?.map((document) =>
            document.unavailable ? (
              <p key={document.documentId}>
                <Trans>Document no longer available</Trans>
              </p>
            ) : (
              <div key={document.documentId}>
                <p className="font-medium text-foreground">{document.documentTitle}</p>
                <ol className="mt-1 space-y-2">
                  {[...document.changes]
                    .sort((a, b) => a.ordinal - b.ordinal)
                    .map((change) => (
                      <ChangeRow
                        key={change.changeId}
                        documentId={document.documentId}
                        change={change}
                        navigateToChange={navigateToChange}
                      />
                    ))}
                </ol>
              </div>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

function ChangeRow({
  documentId,
  change,
  navigateToChange,
}: {
  documentId: string;
  change: TrailChange;
  navigateToChange: (documentId: string, change: TrailChange) => Promise<TrailNavigationResult>;
}) {
  const [selected, setSelected] = useState(false);
  const [navigation, setNavigation] = useState<TrailNavigationResult | null>(null);
  const requestSequence = useRef(0);
  async function select() {
    const next = !selected;
    setSelected(next);
    const request = ++requestSequence.current;
    setNavigation(null);
    if (!next) return;
    const result = await navigateToChange(documentId, change);
    if (request === requestSequence.current) setNavigation(result);
  }
  const presentation = changePresentation(change, navigation);
  return (
    <li>
      <button
        type="button"
        className="focus-ring text-left text-foreground"
        onClick={() => void select()}
      >
        {change.kind === "insert" ? (
          <Trans>Inserted text</Trans>
        ) : change.kind === "modify" ? (
          <Trans>Modified text</Trans>
        ) : (
          <Trans>Deleted text</Trans>
        )}
      </button>
      {change.swept ? (
        <p>
          <Trans>Removed text from a block you recently edited</Trans>
        </p>
      ) : null}
      {selected ? (
        <div className="mt-1 space-y-2 rounded-md bg-surface-subtle p-3">
          {presentation.earlierText ? (
            <p className="whitespace-pre-wrap text-foreground">{presentation.earlierText}</p>
          ) : null}
          {presentation.earlierUnavailable ? (
            <p>
              <Trans>Earlier content could not be recovered</Trans>
            </p>
          ) : null}
          {navigation?.kind === "unavailable" || change.navigation.kind === "unavailable" ? (
            <p>
              <Trans>Original location is no longer available</Trans>
            </p>
          ) : navigation?.kind === "could_not_open" ? (
            <p>
              <Trans>Couldn't open this location</Trans>
            </p>
          ) : presentation.deleteResolved ? (
            <p>
              <Trans>Removed here — nothing replaced it</Trans>
            </p>
          ) : presentation.opening ? (
            <p>
              <Trans>Opening current text…</Trans>
            </p>
          ) : change.kind === "modify" && navigation?.kind === "shown" ? (
            <p>
              <Trans>Current text at this location</Trans>
            </p>
          ) : null}
          <Button
            size="sm"
            disabled={!change.reversible}
            title={!change.reversible ? t`Undo isn't available yet` : undefined}
          >
            <Trans>Undo</Trans>
          </Button>
          {!change.reversible ? (
            <p>
              <Trans>Undo isn't available yet</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** §D/§G concerns are independent: receipt body, missing swept body, and navigation. */
export function changePresentation(change: TrailChange, navigation: TrailNavigationResult | null) {
  const removed = change.swept?.removed;
  const earlierUnavailable = removed?.status === "unavailable";
  const earlierText =
    removed?.status === "available"
      ? removed.markdown
      : change.swept
        ? null
        : change.kind === "insert"
          ? null
          : change.beforeText;
  return {
    earlierText,
    earlierUnavailable,
    opening: navigation === null,
    deleteResolved: change.kind === "delete" && navigation?.kind === "shown",
  };
}
