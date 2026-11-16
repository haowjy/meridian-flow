/**
 * An Agent package's Save state and its Save, one look wherever the writer meets it: a level's
 * heading, an import's folder row, an open Agent file, an applied draft, the AI's write. After a
 * Save the same place says what it did ("Saved" with Undo, or "Not saved: 2 problems").
 */
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

/**
 * `package` (a level's heading, an import's row, a removed import's line): Save alone says there
 * is something to save, since a chip beside it would push a 264px row's name out. `file` (an open
 * file, one the writer or the AI just changed) says "Unsaved" before Save. Either shows a
 * package-level problem (a broken `mars.toml`) as a chip, the one place it is said.
 */
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
  /** A file whose own chip already says what keeps it out of use, left out of the package's count. */
  shownFile?: string;
  /** Shown first, only when there is something to say: the package's name on a line of its own. */
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
    status && counted ? (
      <PackageChanges
        projectId={projectId}
        pkg={pkg}
        status={status}
        undone={look === "package" && word?.kind === "undone"}
      />
    ) : null;
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
          heading={t`Saving ${label} fails until these are fixed`}
          sub={
            status.savedAt
              ? t`New chats keep the version saved before.`
              : t`New chats can't use ${label} until it is saved.`
          }
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
      {/* A Save of a package nothing of which can be read can only fail. */}
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

/** What the last Save or Undo did, where the state shows. */
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
      // Nothing new was saved: the edits kept out of use are all the Save has to say.
      const nothingNew = word.outcome.outcome === "unchanged";
      return (
        <>
          {/* The chip's list opens with what was saved, and a 264px row or a 390px toolbar has no
              room for both. */}
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
          sub={
            word.outcome.savedBefore
              ? t`Your edits are in the files. New chats keep the version saved before until these are fixed and it is saved again.`
              : t`Your edits are in the files. New chats can't use ${label} until these are fixed and it is saved.`
          }
        />
      );
    }
    case "undone":
      return (
        <>
          {look === "file" ? (
            <RowWord
              tone="done"
              word={<Trans>Undone</Trans>}
              sentence={t`Back to the previous saved version, with its text merged into your files. What you changed since is kept, so the package reads Unsaved until it is saved.`}
            />
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
          sentence={t`Couldn't reach the server, so nothing was saved. Retry tries again.`}
          onAction={onSave}
        />
      );
  }
}

/**
 * The count of a package's problems. On its own row the row names the package; on an open file
 * the word does, so a good file of a broken package never reads as broken itself. A long name
 * gives way before the count does: the popover's heading says it in full.
 */
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
  const said = word.settled
    ? t`Saved just now. New chats use it; chats already running keep the version they started with.`
    : t`Saving. New chats will use it; chats already running keep the version they started with.`;
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

/** A package's problems (a broken `mars.toml`), as a chip that lists them by file. */
function PackageProblems({
  projectId,
  pkg,
  findings,
  word,
  heading,
  sub,
}: {
  projectId: string;
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  word: ReactNode;
  heading: string;
  sub?: string;
}) {
  const openFile = useOpenAgentFile(projectId);
  return (
    <FindingsChip tone="destructive" word={word} heading={heading} sub={sub}>
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

/**
 * What of the package is out of use after a Save, counted as every level counts it
 * (`outOfUseWord`): the same before the server answers and after the files are read again. It
 * lists each file with what keeps it out of use, then what the Save did save and its notes.
 */
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
  /** What else the Save said (`savedNotes`). */
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
      heading={held ? heldSummary(outcome).heading : t`Saved ${label}`}
      sub={t`Fix these and save ${label} again.`}
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
                    <Trans>Your latest edit isn't in use:</Trans>
                  ) : trouble.runtime ? (
                    <Trans>New chats can't start it:</Trans>
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

/** What a Save that left something out did save, below what it left out. */
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

/**
 * The heading and sub-line for what a Save kept out of use, naming the items: the AI's card says
 * them, and a package's Save chip says the heading.
 */
export function heldSummary(outcome: SaveOutcome): { heading: string; sub: string } {
  const label = packageLabel(outcome);
  const items = [...outcome.kept, ...outcome.leftOut];
  const names = listOf(items.map((file) => agentsFileOf(file)?.slug ?? file));
  const allLeftOut = outcome.kept.length === 0;
  if (outcome.outcome === "unchanged")
    return {
      heading: t`Nothing new saved in ${label}`,
      sub: t`Your edits to ${names} aren't in use until each problem is fixed and ${label} is saved again.`,
    };
  return {
    heading: allLeftOut
      ? t`Saved ${label} without ${names}`
      : outcome.leftOut.length === 0
        ? t`Saved ${label}, but not the latest edit of ${names}`
        : t`Saved ${label}, but not ${names}`,
    sub: allLeftOut
      ? t`New chats can't use ${names} until each problem is fixed and ${label} is saved again.`
      : t`Where an item had a good save, new chats keep using it until each problem is fixed and ${label} is saved again.`,
  };
}

function listOf(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  const last = items[items.length - 1];
  return t`${head} and ${last}`;
}

/**
 * Findings by file, in the order they came: each file's path, then what a Save did with it ("Left
 * out:", the path struck through, or "Your latest edit isn't in use:"), then each finding in Flow's
 * words. A press on the path opens the file.
 */
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

/**
 * What a settled Save said beyond "Saved" and what it kept out of use (its chip lists those), as
 * lines: renames and warnings; `null` when it said none.
 */
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

/** The errors of the Agent and skill files a Save did not use, in the order it listed them. */
export function heldBack(outcome: SaveOutcome): AgentFinding[] {
  return outcome.findings.filter(
    (finding) =>
      finding.severity === "error" &&
      (outcome.kept.includes(finding.file) || outcome.leftOut.includes(finding.file)),
  );
}

/**
 * The Save state of the package one file is in, for a place that speaks of that file (an open
 * Agent file, an applied draft, the AI's write); nothing for a file in no Agents level.
 */
export function AgentFileSave({
  projectId,
  scheme,
  path,
  before,
}: {
  projectId: string;
  scheme: ContextUriScheme;
  /** The file's path in its scheme, with or without the leading slash. */
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
