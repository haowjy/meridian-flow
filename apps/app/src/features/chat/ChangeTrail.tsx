/** Quiet per-turn trail disclosure and honest historical-change detail. */
import { Trans } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  type ChangeTrailDocument,
  type ChangeTrailShell,
  readChangeTrail,
  type TrailChange,
} from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import type { TrailNavigationResult } from "@/core/editor/change-trail-navigation";
import { useChangeTrailNavigation } from "./useChangeTrailNavigation";

export function ChangeTrail({
  threadId,
  shell,
  gapPending = false,
  turnComplete = false,
}: {
  threadId: string;
  shell: ChangeTrailShell;
  gapPending?: boolean;
  turnComplete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<ChangeTrailDocument[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const navigateToChange = useChangeTrailNavigation(threadId);
  const settled = shell.state === "settled" && !gapPending;
  const label =
    shell.state === "settling" ||
    (turnComplete && shell.state === "building") ||
    (shell.state === "settled" && gapPending)
      ? "Finishing change record…"
      : `Edited ${shell.changeCount} ${shell.changeCount === 1 ? "place" : "places"} across ${shell.documentCount} ${shell.documentCount === 1 ? "document" : "documents"}`;
  async function toggle() {
    if (!settled) return;
    const next = !open;
    setOpen(next);
    if (next && !documents) {
      try {
        setDocuments(await readChangeTrail(threadId, shell.trailId));
      } catch {
        setUnavailable(true);
      }
    }
  }
  return (
    <section
      className="mt-3 text-caption text-muted-foreground"
      data-change-trail-state={gapPending ? "reconciling" : shell.state}
    >
      <button
        type="button"
        disabled={!settled}
        onClick={toggle}
        aria-expanded={open}
        className="focus-ring flex items-center gap-1 disabled:cursor-default"
      >
        {label}
        {settled ? <ChevronDownIcon className="size-3" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="mt-2 space-y-3 border-l border-border-subtle pl-3">
          {unavailable ? (
            <p>
              <Trans>The document is no longer available</Trans>
            </p>
          ) : null}
          {documents?.map((document) => (
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
          ))}
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
  const removed = change.swept?.removed;
  async function select() {
    const next = !selected;
    setSelected(next);
    if (!next) return;
    setNavigation(await navigateToChange(documentId, change));
  }
  return (
    <li>
      <button
        type="button"
        className="focus-ring text-left text-foreground"
        onClick={() => void select()}
      >
        {change.kind === "insert"
          ? "Inserted text"
          : change.kind === "modify"
            ? "Modified text"
            : "Deleted text"}
      </button>
      {change.swept ? <p>Removed text from a block you recently edited</p> : null}
      {selected ? (
        <div className="mt-1 space-y-2 rounded-md bg-surface-subtle p-3">
          {removed?.status === "available" ? (
            <p className="whitespace-pre-wrap text-foreground">{removed.markdown}</p>
          ) : change.beforeText ? (
            <p className="whitespace-pre-wrap text-foreground">{change.beforeText}</p>
          ) : (
            <p>Earlier content could not be recovered</p>
          )}
          {navigation?.kind === "unavailable" || change.navigation.kind === "unavailable" ? (
            <p>Original location is no longer available</p>
          ) : navigation?.kind === "could_not_open" ? (
            <p>Couldn't open this location</p>
          ) : change.kind === "delete" ? (
            <p>Removed here — nothing replaced it</p>
          ) : change.kind === "modify" ? (
            <>
              <p className="font-medium text-foreground">Current text at this location</p>
              {navigation?.kind === "shown" ? (
                <p className="whitespace-pre-wrap text-foreground">{navigation.currentText}</p>
              ) : (
                <p>Opening current text…</p>
              )}
            </>
          ) : null}
          <Button
            size="sm"
            disabled={!change.reversible}
            title={!change.reversible ? "Undo isn't available yet" : undefined}
          >
            Undo
          </Button>
          {!change.reversible ? <p>Undo isn't available yet</p> : null}
        </div>
      ) : null}
    </li>
  );
}
