import { Trans } from "@lingui/react/macro";
import { type AgentFinding, type SaveOutcome, shownFindings } from "@meridian/contracts/agents";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { useOpenAgentFile } from "./agent-file-document";
import { changeLine, FindingList, heldBack, heldHeading } from "./PackageSave";
import { packageLabel } from "./package-save";
import { UndoSave } from "./UndoSave";

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
  const warnings = shownFindings(outcome.findings).filter(
    (finding) => finding.severity !== "error",
  );
  const heldPaths = new Set(
    [...outcome.kept, ...outcome.leftOut].map((file) => `${outcome.folder}${file}`),
  );
  const saved = outcome.changes.filter((change) => !heldPaths.has(change.path));
  return (
    <div className="py-[var(--chat-card-pad-y)]">
      <div className="flex min-h-[calc(var(--strip-row)-2px)] items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)]">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {outcome.outcome === "failed" ? (
            <Trans>Not saved: {label}</Trans>
          ) : held.length > 0 ? (
            heldHeading(outcome)
          ) : outcome.outcome === "saved" ? (
            <Trans>Saved {label}</Trans>
          ) : (
            <Trans>{label} was already saved</Trans>
          )}
        </span>
        {outcome.outcome === "saved" && outcome.saveId && projectId ? (
          <UndoSave projectId={projectId} pkg={outcome} saveId={outcome.saveId} />
        ) : null}
      </div>
      {outcome.outcome === "failed" ? (
        <>
          <p className="px-[var(--chat-card-pad-x)] text-muted-foreground">
            <Trans>Couldn't read it</Trans>
          </p>
          <Findings projectId={projectId} outcome={outcome} findings={outcome.findings} />
        </>
      ) : (
        <>
          {held.length > 0 ? (
            <Findings projectId={projectId} outcome={outcome} findings={held} />
          ) : null}
          {saved.length > 0 ? (
            <ul className="px-[var(--chat-card-pad-x)]">
              {saved.map((change) => (
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
      onOpen={projectId ? (file) => openFile(outcome.level, `${outcome.folder}${file}`) : null}
    />
  );
}
