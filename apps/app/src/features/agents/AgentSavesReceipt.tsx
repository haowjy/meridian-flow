/**
 * What the AI's `save_agents` calls in a turn did, one part per package: the edits an Error keeps
 * out of use first, then what changed, renames, warnings, and Undo; or, for a package not saved,
 * its problems.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentFileChange, AgentFinding, SaveOutcome } from "@meridian/contracts/agents";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import { Button } from "@/components/ui/button";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { FindingList, heldBack, useOpenAgentFile } from "./PackageSave";
import { packageLabel, statusOf, usePackageSaves } from "./package-save";

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
  const held = heldBack(outcome);
  const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
  return (
    <div className="py-[var(--chat-card-pad-y)]">
      <div className="flex min-h-[calc(var(--strip-row)-2px)] items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)]">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {outcome.outcome === "saved" ? (
            <Trans>Saved {label}</Trans>
          ) : outcome.outcome === "failed" ? (
            <Trans>Not saved: {label}</Trans>
          ) : held.length > 0 ? (
            plural(held.length, {
              one: `${label}: # edit not in use`,
              other: `${label}: # edits not in use`,
            })
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
          {held.length > 0 ? (
            <>
              <p className="px-[var(--chat-card-pad-x)] text-foreground">
                <Trans>
                  Each Error stops its edit from being used. Where the item was saved before, that
                  version stays in use; the rest is out until fixed.
                </Trans>
              </p>
              <Findings projectId={projectId} outcome={outcome} findings={held} />
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
}: {
  projectId: string | null;
  outcome: SaveOutcome;
  findings: readonly AgentFinding[];
}) {
  const openFile = useOpenAgentFile(projectId ?? "");
  return (
    <FindingList
      pkg={outcome}
      findings={findings}
      held={outcome}
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
 * Undo of one Save, said as the package's notice says it, from the state every surface shares.
 * Offered only while this is still the package's latest Save: after a reload, a Save already
 * undone or saved over has nothing to undo.
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
  const files = useAgentFiles(projectId);
  const state = saves.undoOf(saveId);
  const label = packageLabel(outcome);
  if (state === "undone")
    return (
      <span className="shrink-0 text-muted-foreground" role="status">
        <Trans>Undone</Trans>
      </span>
    );
  if (state !== "pending" && statusOf(files?.packages, outcome)?.saveId !== saveId) return null;
  return (
    <>
      {state === "failed" ? (
        <span className="shrink-0 text-destructive" role="status">
          <Trans>Undo didn't go through. Try again.</Trans>
        </span>
      ) : null}
      <Button
        type="button"
        variant="quiet"
        size="meta"
        className="shrink-0 text-jade-text"
        aria-label={t`Undo save of ${label}`}
        disabled={state === "pending"}
        onClick={() => void saves.undo({ level: outcome.level, folder: outcome.folder }, saveId)}
      >
        <Trans>Undo</Trans>
      </Button>
    </>
  );
}
