/**
 * An Agent package's Save state and its Save, one look wherever the writer meets it: a level's
 * heading, an import's folder row, an open Agent file, an applied draft, the AI's write. After a
 * Save the same place says what it did ("Saved" with Undo, or "Not saved: 2 problems").
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  AgentFinding,
  AgentPackageStatus,
  AgentsLevel,
  SaveOutcome,
} from "@meridian/contracts/agents";
import { agentsLocationOf, agentsRootOf } from "@meridian/contracts/agents";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { RowWord } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { cn } from "@/lib/utils";
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
 * `package` (a level's heading, an import's row) says "Unsaved changes"; `file` (one file the
 * writer or the AI just changed) says "Unsaved", and a package with an Error shows its problems.
 * `bare`: the line around it already says the state (a removed import), so only Save shows.
 */
export type PackageSaveLook = "package" | "file" | "bare";

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
    <Word projectId={projectId} pkg={pkg} word={word} onSave={save} />
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
  const errors = packageErrorsOf(status.findings);
  return (
    <>
      {look === "bare" ? null : look === "file" && failsSave(status) ? (
        <ProblemsButton
          projectId={projectId}
          pkg={pkg}
          findings={errors}
          word={plural(errors.length, { one: "# problem", other: "# problems" })}
          heading={t`Saving ${label} fails until these are fixed`}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Chip tabIndex={0} className="focus-ring" data-package-state={status.state}>
              {status.state === "not-saved" ? (
                <Trans>Not saved yet</Trans>
              ) : look === "file" ? (
                <Trans>Unsaved</Trans>
              ) : (
                <Trans>Unsaved changes</Trans>
              )}
            </Chip>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            {status.state === "not-saved"
              ? t`New chats can't use ${label} until it is saved.`
              : plural(status.changes.length, {
                  one: "# file differs from the version new chats use.",
                  other: "# files differ from the version new chats use.",
                })}
          </TooltipContent>
        </Tooltip>
      )}
      <SaveButton label={label} onSave={onSave} />
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
}: {
  projectId: string;
  pkg: PackageRef;
  word: PackageWord;
  onSave: (() => void) | undefined;
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
          {nothingNew ? null : (
            <RowWord tone="done" word={<Trans>Saved</Trans>} sentence={savedSentence(word)} />
          )}
          {held.length > 0 ? (
            <ProblemsButton
              projectId={projectId}
              pkg={pkg}
              findings={held}
              word={plural(held.length, { one: "# edit not in use", other: "# edits not in use" })}
              heading={
                nothingNew
                  ? t`${label} has nothing new to save, and these edits aren't in use`
                  : t`Saved ${label}, but these edits aren't in use`
              }
              held={word.outcome}
              note={t`Each Error stops its edit from being used. Where the item was saved before, that version stays in use; the rest is out until the Error is fixed and the package is saved again.`}
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
      const count = word.outcome.findings.length;
      return (
        <ProblemsButton
          projectId={projectId}
          pkg={pkg}
          findings={word.outcome.findings}
          word={plural(count, { one: "Not saved: # problem", other: "Not saved: # problems" })}
          heading={t`${label} was not saved`}
          note={t`Your edits are in the files. New chats keep the saved version until these are fixed and it is saved again.`}
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

/** A count of problems that opens them, each a way to its file. */
function ProblemsButton({
  projectId,
  pkg,
  findings,
  word,
  heading,
  note,
  held,
}: {
  projectId: string;
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  word: string;
  heading: string;
  note?: string;
  held?: Pick<SaveOutcome, "kept" | "leftOut">;
}) {
  const [open, setOpen] = useState(false);
  const openFile = useOpenAgentFile(projectId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-package-problems
          className="focus-ring flex shrink-0 select-none items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground hover:text-foreground coarse:min-h-11"
          onClick={(event) => event.stopPropagation()}
        >
          <TriangleAlert aria-hidden className="size-3.5 text-warning-ink" />
          {word}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-2 pt-1 text-sm font-medium text-foreground">{heading}</p>
        {note ? <p className="px-2 pb-1 text-xs text-muted-foreground">{note}</p> : null}
        <FindingList
          pkg={pkg}
          findings={findings}
          held={held}
          onOpen={(finding) => {
            setOpen(false);
            openFile(pkg.level, `${pkg.folder}${finding.file}`);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Each finding as its file and Mars's words; a press opens the file. */
export function FindingList({
  pkg,
  findings,
  onOpen,
  held,
  className,
}: {
  pkg: PackageRef;
  findings: readonly AgentFinding[];
  onOpen: ((finding: AgentFinding) => void) | null;
  /**
   * What a Save did with the files: one with no saved version in use is struck through, one that
   * keeps its last saved version says its latest edit isn't in use.
   */
  held?: Pick<SaveOutcome, "kept" | "leftOut">;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {findings.map((finding, index) => {
        const where = `${pkg.folder}${finding.file}`;
        const message = finding.message;
        const body = (
          <>
            <span
              className={cn(
                "block truncate text-foreground",
                held?.leftOut.includes(finding.file) && "line-through",
              )}
            >
              {where}
            </span>
            <span className="block whitespace-pre-line break-words text-muted-foreground">
              {held?.kept.includes(finding.file)
                ? t`Your latest edit isn't in use: ${message}`
                : message}
            </span>
          </>
        );
        return (
          <li key={`${index}:${finding.file}:${finding.code}`}>
            {onOpen ? (
              <button
                type="button"
                className="focus-ring w-full rounded-md px-2 py-1 text-left text-xs hover:bg-ink-fill"
                onClick={() => onOpen(finding)}
              >
                {body}
              </button>
            ) : (
              <span className="block px-2 py-1 text-xs">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What a settled Save said beyond "Saved", as lines: the edits an Error keeps out of use first,
 * then renames and warnings; `null` when it said none. The Save's Undo stays beside its word.
 */
export function savedNotes(word: PackageWord | null): string[] | null {
  if (word?.kind !== "saved" || !word.settled) return null;
  const { renamed, findings, kept } = word.outcome;
  const lines = [
    ...heldBack(word.outcome).map((finding) =>
      kept.includes(finding.file)
        ? t`${finding.file}: your latest edit isn't in use: ${finding.message}`
        : t`${finding.file} isn't in use: ${finding.message}`,
    ),
    ...renamed,
    ...findings
      .filter((finding) => finding.severity === "warning")
      .map((finding) => `${finding.file}: ${finding.message}`),
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
