/**
 * An Agent package's Save state and its Save, one look wherever the writer meets it: a level's
 * heading, an import's folder row, an open Agent file, an applied draft, the AI's write. After a
 * Save the same place says what it did ("Saved" with Undo, or "Not saved: 2 problems").
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  AgentFileChange,
  AgentFinding,
  AgentPackageStatus,
  AgentsLevel,
  SaveOutcome,
} from "@meridian/contracts/agents";
import { agentsFileOf, agentsLocationOf, agentsRootOf } from "@meridian/contracts/agents";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { ReactNode } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { RowWord } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { cn } from "@/lib/utils";
import { FindingsChip, SentenceList } from "./FindingsChip";
import { findingSentence, findingsOfFile } from "./findings";
import {
  failsSave,
  type PackageRef,
  type PackageWord,
  packageErrorsOf,
  packageFolderOf,
  packageLabel,
  statusOf,
  usePackageSaves,
} from "./package-save";

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
}: {
  projectId: string;
  pkg: PackageRef;
  status: AgentPackageStatus | undefined;
  look?: PackageSaveLook;
  /** Shown first, only when there is something to say: the package's name on a line of its own. */
  before?: ReactNode;
}) {
  const saves = usePackageSaves(projectId);
  const word = saves.wordOf(pkg, status);
  const save = status ? () => void saves.save([status]) : undefined;
  const content = word ? (
    <Word projectId={projectId} pkg={pkg} word={word} onSave={save} look={look} />
  ) : status && status.state !== "saved" ? (
    <StateAndSave projectId={projectId} pkg={pkg} status={status} look={look} onSave={save} />
  ) : null;
  if (!content) return null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-package-save>
      {before}
      {content}
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
  const differs =
    status.state === "not-saved"
      ? t`New chats can't use ${label} until it is saved.`
      : plural(status.changes.length, {
          one: "# file differs from the version new chats use.",
          other: "# files differ from the version new chats use.",
        });
  const problems = packageErrorsOf(status.findings);
  return (
    <>
      {failsSave(status) ? (
        <PackageProblems
          projectId={projectId}
          pkg={pkg}
          findings={problems}
          word={plural(problems.length, { one: "# problem", other: "# problems" })}
          heading={t`Saving ${label} fails until these are fixed`}
          sub={
            status.savedAt
              ? t`New chats keep the version saved before.`
              : t`New chats can't use ${label} until it is saved.`
          }
        />
      ) : look === "file" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Chip tabIndex={0} className="focus-ring" data-package-state={status.state}>
              {status.state === "not-saved" ? <Trans>Not saved yet</Trans> : <Trans>Unsaved</Trans>}
            </Chip>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            {differs}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* A Save of a package nothing of which can be read can only fail. */}
      {failsSave(status) ? null : (
        <SaveButton label={label} onSave={onSave} tip={look === "package" ? differs : undefined} />
      )}
    </>
  );
}

function SaveButton({
  label,
  onSave,
  tip,
}: {
  label: string;
  onSave: (() => void) | undefined;
  /** Where Save stands alone, what there is to save. */
  tip?: string;
}) {
  const button = (
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
  if (!tip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** What the last Save or Undo did, where the state shows. */
function Word({
  projectId,
  pkg,
  word,
  onSave,
  look,
}: {
  projectId: string;
  pkg: PackageRef;
  word: PackageWord;
  onSave: (() => void) | undefined;
  look: PackageSaveLook;
}) {
  const saves = usePackageSaves(projectId);
  const label = packageLabel(pkg);
  switch (word.kind) {
    case "saved": {
      const { saveId } = word.outcome;
      const undoState = saveId ? saves.undoOf(saveId) : undefined;
      const held = heldBack(word.outcome);
      // Nothing new was saved: the edits kept out of use are all the Save has to say.
      const nothingNew = word.outcome.outcome === "unchanged";
      return (
        <>
          {/* On a sidebar row the chip's heading says "Saved", and the row has no room for both. */}
          {nothingNew || (look === "package" && held.length > 0) ? null : (
            <RowWord tone="done" word={<Trans>Saved</Trans>} sentence={savedSentence(word)} />
          )}
          {held.length > 0 ? (
            <PackageProblems
              projectId={projectId}
              pkg={pkg}
              findings={held}
              held={word.outcome}
              {...heldSummary(word.outcome)}
            />
          ) : null}
          {nothingNew ? null : (
            <RowWord
              tone={undoState === "failed" ? "warning" : "action"}
              word={<Trans>Undo</Trans>}
              label={t`Undo save of ${label}`}
              sentence={
                undoState === "failed"
                  ? t`Couldn't reach the server. Undo tries again.`
                  : t`Undo goes back to the previous saved version and merges its text into your files. An edit made since is kept, and where you changed the same text yours stays.`
              }
              pending={!saveId || undoState === "pending"}
              onAction={saveId ? () => void saves.undo(pkg, saveId) : undefined}
            />
          )}
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
          word={
            // On a 264px package row the longer word pushes the package's name out.
            look === "package"
              ? plural(problems.length, { one: "# problem", other: "# problems" })
              : plural(problems.length, {
                  one: "Not saved: # problem",
                  other: "Not saved: # problems",
                })
          }
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
          <RowWord
            tone="done"
            word={<Trans>Undone</Trans>}
            sentence={t`Back to the previous saved version, with its text merged into your files. What you changed since is kept, so the package reads Unsaved until it is saved.`}
          />
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

/** A package's problems, or what a Save left out, as a chip that lists them by file. */
function PackageProblems({
  projectId,
  pkg,
  findings,
  word,
  heading,
  sub,
  held,
}: {
  projectId: string;
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  word: string;
  heading: string;
  sub?: string;
  held?: SaveOutcome;
}) {
  const openFile = useOpenAgentFile(projectId);
  return (
    <FindingsChip
      tone={held && held.leftOut.length === 0 ? "warning" : "destructive"}
      word={word}
      heading={heading}
      sub={sub}
    >
      {(close) => (
        <>
          <FindingList
            pkg={pkg}
            findings={findings}
            held={held}
            onOpen={(file) => {
              close();
              openFile(pkg.level, `${pkg.folder}${file}`);
            }}
          />
          {held ? <SavedChanges outcome={held} /> : null}
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
 * The words for what a Save kept out of use: "1 left out" when nothing it held back has a good
 * save, else "1 not in use", and a heading naming the items.
 */
export function heldSummary(outcome: SaveOutcome): { word: string; heading: string; sub: string } {
  const label = packageLabel(outcome);
  const items = [...outcome.kept, ...outcome.leftOut];
  const names = listOf(items.map((file) => agentsFileOf(file)?.slug ?? file));
  const count = items.length;
  const allLeftOut = outcome.kept.length === 0;
  const nothingNew = outcome.outcome === "unchanged";
  return {
    word: allLeftOut
      ? plural(count, { one: "# left out", other: "# left out" })
      : plural(count, { one: "# not in use", other: "# not in use" }),
    heading: nothingNew
      ? t`${label} has nothing new to save`
      : allLeftOut
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
  const files = [...new Set(findings.map((finding) => finding.file))];
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
              items={findingsOfFile(findings, file).map(findingSentence)}
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
    ...findings
      .filter((finding) => finding.severity === "warning")
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

/** Opens a level's file by its level-relative path, once the trees list it. */
export function useOpenAgentFile(projectId: string) {
  const trees = useProjectTreeViews(projectId, AGENTS_SCHEMES, {});
  const open = useOpenProjectDocument(projectId);
  return (level: AgentsLevel, path: string) => {
    const root = agentsRootOf(level);
    const tree = root.scheme === "user" ? trees.user.tree : trees.agents.tree;
    const entry = tree?.findPath(`/${[root.path, path].filter(Boolean).join("/")}`);
    if (entry?.kind === "file") void open({ documentId: entry.documentId, focus: true });
  };
}

const AGENTS_SCHEMES = ["agents", "user"] as const;

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
