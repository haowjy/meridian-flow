import { plural, t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type {
  AgentFileChange,
  AgentFinding,
  AgentPackageStatus,
  SaveOutcome,
} from "@meridian/contracts/agents";
import { agentsFileOf, agentsLocationOf, shownFindings } from "@meridian/contracts/agents";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { ReactNode } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import { RowWord } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOpenAgentFile } from "./agent-file-document";
import { FindingsChip, SentenceList } from "./FindingsChip";
import { findingSentence, type OutOfUse, outOfUseAfterSave, outOfUseWord } from "./findings";
import { PackageChanges } from "./PackageChanges";
import {
  failsSave,
  importName,
  type PackageRef,
  type PackageWord,
  packageErrorsOf,
  packageFolderOf,
  packageLabel,
  statusOf,
  usePackageSaves,
} from "./package-save";
import { UndoSave } from "./UndoSave";

export type PackageSaveLook = "package" | "file";

export function PackageSave({
  projectId,
  pkg,
  status,
  look = "package",
  before,
  shownFile,
}: {
  projectId: string;
  pkg: PackageRef;
  status: AgentPackageStatus | undefined;
  look?: PackageSaveLook;
  shownFile?: string;
  before?: ReactNode;
}) {
  const saves = usePackageSaves(projectId);
  const word = saves.wordOf(pkg, status);
  const saveId = status?.undoable?.saveId;
  const undo = saveId ? <UndoSave projectId={projectId} pkg={pkg} saveId={saveId} /> : null;
  const save = status ? () => void saves.save([status]) : undefined;
  const content = word ? (
    <Word
      projectId={projectId}
      pkg={pkg}
      word={word}
      onSave={save}
      look={look}
      shownFile={shownFile}
    />
  ) : status && status.state !== "saved" ? (
    <StateAndSave projectId={projectId} pkg={pkg} status={status} look={look} onSave={save} />
  ) : null;
  if (!content && !undo) return null;
  const counted =
    look === "package"
      ? word?.kind !== "saved"
      : word
        ? word.kind !== "saved"
        : status && failsSave(status);
  const changes =
    status && counted ? <PackageChanges projectId={projectId} pkg={pkg} status={status} /> : null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-package-save>
      {before}
      {changes}
      {content}
      {undo}
    </span>
  );
}

function StateAndSave({
  projectId,
  pkg,
  status,
  look,
  onSave,
}: {
  projectId: string;
  pkg: PackageRef;
  status: AgentPackageStatus;
  look: PackageSaveLook;
  onSave: (() => void) | undefined;
}) {
  const label = packageLabel(pkg);
  const problems = packageErrorsOf(status.findings);
  return (
    <>
      {failsSave(status) ? (
        <PackageProblems
          projectId={projectId}
          pkg={pkg}
          findings={problems}
          word={problemsWord(pkg, problems.length, look)}
          heading={t`Can't save ${label}`}
        />
      ) : look === "file" ? (
        <PackageChanges
          projectId={projectId}
          pkg={pkg}
          status={status}
          word={
            <span data-package-state={status.state}>
              {status.state === "not-saved" ? <Trans>Not saved yet</Trans> : <Trans>Unsaved</Trans>}
            </span>
          }
        />
      ) : null}
      {failsSave(status) ? null : <SaveButton label={label} onSave={onSave} />}
    </>
  );
}

function SaveButton({ label, onSave }: { label: string; onSave: (() => void) | undefined }) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      aria-label={t`Save ${label}`}
      className="-my-1 text-jade-text"
      disabled={!onSave}
      onClick={(event) => {
        event.stopPropagation();
        onSave?.();
      }}
    >
      <Trans>Save</Trans>
    </Button>
  );
}

function Word({
  projectId,
  pkg,
  word,
  onSave,
  look,
  shownFile,
}: {
  projectId: string;
  pkg: PackageRef;
  word: PackageWord;
  onSave: (() => void) | undefined;
  look: PackageSaveLook;
  shownFile: string | undefined;
}) {
  const files = useAgentFiles(projectId);
  const label = packageLabel(pkg);
  switch (word.kind) {
    case "saved": {
      const out = outOfUseAfterSave(files?.files ?? [], files?.packages ?? [], pkg).filter(
        (item) => item.file.path !== shownFile,
      );
      const nothingNew = word.outcome.outcome === "unchanged";
      return (
        <>
          {nothingNew || out.length > 0 ? null : (
            <RowWord tone="done" word={<Trans>Saved</Trans>} sentence={savedSentence(word)} />
          )}
          {out.length > 0 ? (
            <OutOfUseChip
              projectId={projectId}
              pkg={pkg}
              outcome={word.outcome}
              items={out}
              notes={savedNotes(word) ?? []}
            />
          ) : null}
        </>
      );
    }
    case "failed": {
      const problems = word.outcome.findings;
      return (
        <PackageProblems
          projectId={projectId}
          pkg={pkg}
          findings={problems}
          word={problemsWord(pkg, problems.length, look)}
          heading={t`${label} wasn't saved`}
        />
      );
    }
    case "undone":
      return (
        <>
          {look === "file" ? (
            <RowWord tone="done" word={<Trans>Undone</Trans>} sentence={t`Undone`} />
          ) : null}
          <SaveButton label={label} onSave={onSave} />
        </>
      );
    case "unreached":
      return (
        <RowWord
          tone="warning"
          word={<Trans>Retry</Trans>}
          label={t`Retry saving ${label}`}
          sentence={t`Couldn't save`}
          onAction={onSave}
        />
      );
  }
}

function problemsWord(pkg: PackageRef, count: number, look: PackageSaveLook): ReactNode {
  if (look === "package") return plural(count, { one: "# problem", other: "# problems" });
  const name = (
    <span className="inline-block max-w-16 truncate align-bottom">
      {pkg.folder ? importName(pkg.folder) : packageLabel(pkg)}
    </span>
  );
  return (
    <span>
      <Plural
        value={count}
        one={
          <>
            {name} can't be saved: {count} problem
          </>
        }
        other={
          <>
            {name} can't be saved: {count} problems
          </>
        }
      />
    </span>
  );
}

function savedSentence(word: Extract<PackageWord, { kind: "saved" }>): ReactNode {
  const said = word.settled ? t`Saved` : t`Saving`;
  const notes = savedNotes(word) ?? [];
  return (
    <>
      {said}
      {notes.map((line) => (
        <span key={line} className="mt-1 block">
          {line}
        </span>
      ))}
    </>
  );
}

function PackageProblems({
  projectId,
  pkg,
  findings,
  word,
  heading,
}: {
  projectId: string;
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  word: ReactNode;
  heading: string;
}) {
  const openFile = useOpenAgentFile(projectId);
  return (
    <FindingsChip tone="destructive" word={word} heading={heading}>
      {(close) => (
        <FindingList
          pkg={pkg}
          findings={findings}
          onOpen={(file) => {
            close();
            openFile(pkg.level, `${pkg.folder}${file}`);
          }}
        />
      )}
    </FindingsChip>
  );
}

function OutOfUseChip({
  projectId,
  pkg,
  outcome,
  items,
  notes,
}: {
  projectId: string;
  pkg: PackageRef;
  outcome: SaveOutcome;
  items: readonly OutOfUse[];
  notes: readonly string[];
}) {
  const openFile = useOpenAgentFile(projectId);
  const out = outOfUseWord(items);
  if (!out) return null;
  const label = packageLabel(pkg);
  const held = outcome.kept.length + outcome.leftOut.length > 0;
  const ordered = [...items].sort(
    (a, b) => Number(a.trouble.kind !== "unavailable") - Number(b.trouble.kind !== "unavailable"),
  );
  return (
    <FindingsChip
      tone={out.tone}
      word={out.word}
      heading={held ? heldHeading(outcome) : t`Saved ${label}`}
    >
      {(close) => (
        <>
          <ul className="flex flex-col">
            {ordered.map(({ file, trouble }) => (
              <li key={file.path} className="px-2 py-1 text-xs">
                <button
                  type="button"
                  className="focus-ring -mx-1 block max-w-full rounded-sm px-1 text-left hover:bg-ink-fill"
                  onClick={() => {
                    close();
                    openFile(pkg.level, file.path);
                  }}
                >
                  <span
                    className={cn(
                      "block truncate text-foreground",
                      trouble.kind === "unavailable" && "line-through",
                    )}
                  >
                    {file.path}
                  </span>
                </button>
                <span className="block text-muted-foreground">
                  {trouble.kind === "not-in-use" ? (
                    <Trans>Not in use:</Trans>
                  ) : trouble.runtime ? (
                    <Trans>Can't start:</Trans>
                  ) : (
                    <Trans>Left out:</Trans>
                  )}
                </span>
                <SentenceList items={trouble.problems} className="px-0 pr-0 pl-4" />
              </li>
            ))}
          </ul>
          <SavedChanges outcome={outcome} />
          {notes.length > 0 ? (
            <SentenceList
              items={notes}
              className="border-border-subtle border-t text-muted-foreground"
            />
          ) : null}
        </>
      )}
    </FindingsChip>
  );
}

function SavedChanges({ outcome }: { outcome: SaveOutcome }) {
  const held = new Set(
    [...outcome.kept, ...outcome.leftOut].map((file) => `${outcome.folder}${file}`),
  );
  const changes = outcome.changes.filter((change) => !held.has(change.path));
  if (changes.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col border-border-subtle border-t px-2 pt-1 text-muted-foreground text-xs">
      {changes.map((change) => (
        <li key={change.path} className="truncate py-0.5">
          {changeLine(change)}
        </li>
      ))}
    </ul>
  );
}

export function changeLine({ path, change }: AgentFileChange): string {
  switch (change) {
    case "added":
      return t`${path} added`;
    case "changed":
      return t`${path} changed`;
    case "deleted":
      return t`${path} deleted`;
  }
}

export function heldHeading(outcome: SaveOutcome): string {
  const label = packageLabel(outcome);
  const items = [...outcome.kept, ...outcome.leftOut];
  const names = listOf(items.map((file) => agentsFileOf(file)?.slug ?? file));
  const allLeftOut = outcome.kept.length === 0;
  if (outcome.outcome === "unchanged") return t`Nothing new saved in ${label}`;
  if (allLeftOut) return t`Saved ${label} without ${names}`;
  return outcome.leftOut.length === 0
    ? t`Saved ${label}, but not the latest edit of ${names}`
    : t`Saved ${label}, but not ${names}`;
}

function listOf(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  const last = items[items.length - 1];
  return t`${head} and ${last}`;
}

export function FindingList({
  pkg,
  findings,
  onOpen,
  held,
  className,
}: {
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  onOpen: ((file: string) => void) | null;
  held?: Pick<SaveOutcome, "kept" | "leftOut">;
  className?: string;
}) {
  const shown = shownFindings(findings);
  const files = [...new Set(shown.map((finding) => finding.file))];
  return (
    <ul className={cn("flex flex-col", className)}>
      {files.map((file) => {
        const where = (
          <span
            className={cn(
              "block truncate text-foreground",
              held?.leftOut.includes(file) && "line-through",
            )}
          >
            {`${pkg.folder}${file}`}
          </span>
        );
        return (
          <li key={file} className="px-2 py-1 text-xs">
            {onOpen ? (
              <button
                type="button"
                className="focus-ring -mx-1 block max-w-full rounded-sm px-1 text-left hover:bg-ink-fill"
                onClick={() => onOpen(file)}
              >
                {where}
              </button>
            ) : (
              where
            )}
            {held?.kept.includes(file) ? (
              <span className="block text-muted-foreground">
                <Trans>Your latest edit isn't in use:</Trans>
              </span>
            ) : held?.leftOut.includes(file) ? (
              <span className="block text-muted-foreground">
                <Trans>Left out:</Trans>
              </span>
            ) : null}
            <SentenceList
              items={shown.filter((finding) => finding.file === file).map(findingSentence)}
              className="px-0 pr-0 pl-4"
            />
          </li>
        );
      })}
    </ul>
  );
}

export function savedNotes(word: PackageWord | null): string[] | null {
  if (word?.kind !== "saved" || !word.settled) return null;
  const { renamed, findings } = word.outcome;
  const lines = [
    ...renamed,
    ...shownFindings(findings)
      .filter((finding) => finding.severity !== "error")
      .map((finding) => `${finding.file}: ${findingSentence(finding)}`),
  ];
  return lines.length ? lines : null;
}

export function heldBack(outcome: SaveOutcome): AgentFinding[] {
  return outcome.findings.filter(
    (finding) =>
      finding.severity === "error" &&
      (outcome.kept.includes(finding.file) || outcome.leftOut.includes(finding.file)),
  );
}

export function AgentFileSave({
  projectId,
  scheme,
  path,
  before,
}: {
  projectId: string;
  scheme: ContextUriScheme;
  path: string;
  before?: ReactNode;
}) {
  const at = agentsLocationOf(scheme, path.replace(/^\//, ""));
  const files = useAgentFiles(at ? projectId : "");
  if (!at) return null;
  const pkg = { level: at.level, folder: packageFolderOf(at.path) };
  return (
    <PackageSave
      projectId={projectId}
      pkg={pkg}
      status={statusOf(files?.packages, pkg)}
      look="file"
      before={before}
    />
  );
}
