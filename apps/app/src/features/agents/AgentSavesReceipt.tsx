/**
 * What the AI's `save_agents` calls in a turn did, one part per package: the files it left out
 * for an Error first, struck through, then what changed, renames, warnings, and Undo; or, for a
 * package not saved, its problems.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentFileChange, AgentFinding, SaveOutcome } from "@meridian/contracts/agents";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { FindingList, leftOutErrors, useOpenAgentFile } from "./PackageSave";
import { packageLabel, type UndoAnswer, usePackageSaves } from "./package-save";

export function AgentSavesReceipt({ outcomes }: { outcomes: readonly SaveOutcome[] }) {
  const projectId = useProjectDocumentNavigationProjectId();
  if (outcomes.length === 0) return null;
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card text-xs text-muted-foreground"
      data-agent-saves-receipt
    >
      <ul className="flex flex-col">
        {outcomes.map((outcome, index) => (
          <li
            key={`${outcome.level}:${outcome.folder}:${outcome.saveId ?? index}`}
            className={index > 0 ? "border-border-subtle border-t" : undefined}
          >
            <OutcomePart outcome={outcome} projectId={projectId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutcomePart({ outcome, projectId }: { outcome: SaveOutcome; projectId: string | null }) {
  const label = packageLabel(outcome);
  const leftOut = leftOutErrors(outcome);
  const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
  return (
    <div className="py-[var(--chat-card-pad-y)]">
      <div className="flex min-h-[calc(var(--strip-row)-2px)] items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)]">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {outcome.outcome === "saved" ? (
            <Trans>Saved {label}</Trans>
          ) : outcome.outcome === "failed" ? (
            <Trans>Not saved: {label}</Trans>
          ) : (
            <Trans>{label} was already saved</Trans>
          )}
        </span>
        {outcome.outcome === "saved" && outcome.saveId && projectId ? (
          <UndoSave projectId={projectId} outcome={outcome} saveId={outcome.saveId} />
        ) : null}
      </div>
      {outcome.outcome === "failed" ? (
        <>
          <p className="px-[var(--chat-card-pad-x)] text-muted-foreground">
            <Trans>
              Nothing in it could be read. New chats keep the previous saved version until this is
              fixed.
            </Trans>
          </p>
          <Findings projectId={projectId} outcome={outcome} findings={outcome.findings} />
        </>
      ) : (
        <>
          {leftOut.length > 0 ? (
            <>
              <p className="px-[var(--chat-card-pad-x)] text-foreground">
                <Trans>Left out, each with an Error: new chats can't use them yet.</Trans>
              </p>
              <Findings projectId={projectId} outcome={outcome} findings={leftOut} crossedOut />
            </>
          ) : null}
          {outcome.changes.length > 0 ? (
            <ul className="px-[var(--chat-card-pad-x)]">
              {outcome.changes.map((change) => (
                <li key={change.path} className="truncate">
                  {changeLine(change)}
                </li>
              ))}
            </ul>
          ) : null}
          {outcome.renamed.map((line) => (
            <p key={line} className="px-[var(--chat-card-pad-x)] text-foreground">
              {line}
            </p>
          ))}
          {warnings.length > 0 ? (
            <Findings projectId={projectId} outcome={outcome} findings={warnings} />
          ) : null}
        </>
      )}
    </div>
  );
}

function Findings({
  projectId,
  outcome,
  findings,
  crossedOut,
}: {
  projectId: string | null;
  outcome: SaveOutcome;
  findings: readonly AgentFinding[];
  crossedOut?: boolean;
}) {
  const openFile = useOpenAgentFile(projectId ?? "");
  return (
    <FindingList
      pkg={outcome}
      findings={findings}
      crossedOut={crossedOut}
      className="px-[calc(var(--chat-card-pad-x)-0.5rem)]"
      onOpen={
        projectId ? (finding) => openFile(outcome.level, `${outcome.folder}${finding.file}`) : null
      }
    />
  );
}

function changeLine({ path, change }: AgentFileChange): string {
  switch (change) {
    case "added":
      return t`${path} added`;
    case "changed":
      return t`${path} changed`;
    case "deleted":
      return t`${path} deleted`;
  }
}

/**
 * Undo of one Save, said in the card: the package goes back to the version before, its files
 * restored with any edit made since kept.
 */
function UndoSave({
  projectId,
  outcome,
  saveId,
}: {
  projectId: string;
  outcome: SaveOutcome;
  saveId: string;
}) {
  const saves = usePackageSaves(projectId);
  const [answer, setAnswer] = useState<UndoAnswer | "pending" | null>(null);
  const label = packageLabel(outcome);
  if (answer === "undone" || answer === "nothing")
    return (
      <span className="shrink-0 text-muted-foreground" role="status">
        {answer === "undone" ? (
          <Trans>Undone: {label} is back to its previous saved version and files.</Trans>
        ) : (
          <Trans>Not undone: {label} was saved again since.</Trans>
        )}
      </span>
    );
  return (
    <>
      {answer === "failed" ? (
        <span className="shrink-0 text-destructive" role="status">
          <Trans>Couldn't reach the server.</Trans>
        </span>
      ) : null}
      <Button
        type="button"
        variant="quiet"
        size="meta"
        className="shrink-0 text-jade-text"
        aria-label={t`Undo save of ${label}`}
        disabled={answer === "pending"}
        onClick={() => {
          setAnswer("pending");
          void saves.undo({ level: outcome.level, folder: outcome.folder }, saveId).then(setAnswer);
        }}
      >
        {answer === "pending" ? <Trans>Undoing…</Trans> : <Trans>Undo</Trans>}
      </Button>
    </>
  );
}
