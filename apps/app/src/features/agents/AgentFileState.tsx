import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  type AgentFileStatus,
  type AgentLevel,
  agentsLocationOf,
} from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import type { OpenDocument } from "@/client/stores";
import { FindingsChip, SentenceList } from "./FindingsChip";
import { type FileTrouble, fileTrouble } from "./findings";
import { PackageSave } from "./PackageSave";
import { packageFolderOf, statusOf } from "./package-save";

/** The verdict on the file at a tree path, when it is an Agent or skill file of a level. */
export function agentFileAt(
  files: readonly AgentFileStatus[] | null,
  scheme: ProjectContextTreeScheme,
  treePath: string,
): AgentFileStatus | null | undefined {
  const at = agentsLocationOf(scheme, treePath.replace(/^\//, ""));
  if (!at) return null;
  if (!files) return undefined;
  return files.find((file) => file.level === at.level && file.path === at.path) ?? null;
}

/** A level as the picker and the Agents tab name it. */
export function levelLabel(level: AgentLevel): string {
  switch (level) {
    case "project":
      return t`Project`;
    case "user":
      return t`Yours`;
    case "builtin":
      return t`Built-in`;
  }
}

/** Whose file of this name it is, inside a sentence: "the built-in critic". */
function whose(level: AgentLevel, slug: string): string {
  switch (level) {
    case "project":
      return t`this project's ${slug}`;
    case "user":
      return t`your ${slug}`;
    case "builtin":
      return t`the built-in ${slug}`;
  }
}

function listOf(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  const last = items[items.length - 1];
  return t`${head} and ${last}`;
}

/** For the picker's tooltip: whose this Agent is and whose it hides. */
export function hidesSentence(level: AgentLevel, shadows: readonly AgentLevel[]): string {
  const below = listOf(
    shadows.map((item) =>
      item === "user" ? t`yours` : item === "builtin" ? t`the built-in one` : t`the project's`,
    ),
  );
  return level === "project"
    ? t`This project's own; it hides ${below}.`
    : t`Your own; it hides ${below}.`;
}

/**
 * An open file of an Agents level, at the end of its toolbar row: what keeps it from use (its
 * problems, or a level above that hides it), its notes, and its package's Save state with Save.
 * The verdicts are read again each time a level's text changes (`useProjectWake`), so it follows
 * the typing. A file with nothing to say shows nothing.
 */
export function AgentFileState({
  projectId,
  document,
  touch = false,
}: {
  projectId: string;
  document: OpenDocument;
  touch?: boolean;
}) {
  if (document.kind !== "tracked") return null;
  const at = agentsLocationOf(document.scheme, document.path.replace(/^\//, ""));
  return at ? (
    <LevelFileState
      projectId={projectId}
      scheme={document.scheme}
      path={document.path}
      touch={touch}
    />
  ) : null;
}

function LevelFileState({
  projectId,
  scheme,
  path,
  touch,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  touch: boolean;
}) {
  useLingui();
  const files = useAgentFiles(projectId);
  const at = agentsLocationOf(scheme, path.replace(/^\//, ""));
  const file = agentFileAt(files?.files ?? null, scheme, path);
  if (!at || !files) return null;
  const pkg = { level: at.level, folder: packageFolderOf(at.path) };
  const status = statusOf(files.packages, pkg);
  const trouble = file ? fileTrouble(file, status) : null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-agent-file-state>
      {file && trouble ? <TroubleChip file={file} trouble={trouble} touch={touch} /> : null}
      <PackageSave
        projectId={projectId}
        pkg={pkg}
        status={status}
        look="file"
        shownFile={trouble ? file?.path : undefined}
      />
    </span>
  );
}

/** What keeps a file from use, as a chip that opens its problems; also the built-in dialog's. */
export function TroubleChip({
  file,
  trouble,
  touch,
}: {
  file: AgentFileStatus;
  trouble: FileTrouble;
  touch?: boolean;
}) {
  const name = file.slug;
  switch (trouble.kind) {
    case "unavailable":
      return (
        <FindingsChip
          tone="destructive"
          touch={touch}
          word={t`Unavailable`}
          heading={t`${name} is unavailable`}
        >
          {() => <SentenceList items={trouble.problems} />}
        </FindingsChip>
      );
    case "not-in-use":
      return (
        <FindingsChip
          tone="warning"
          touch={touch}
          word={t`Not in use`}
          heading={t`Your latest edit isn't in use`}
        >
          {() => <SentenceList items={trouble.problems} />}
        </FindingsChip>
      );
    case "hidden":
      return (
        <FindingsChip
          tone="neutral"
          touch={touch}
          word={t`Hidden`}
          heading={t`Not used: ${whose(trouble.by, name)} hides it`}
        >
          {() => null}
        </FindingsChip>
      );
    case "notes":
      return (
        <FindingsChip
          tone="neutral"
          touch={touch}
          word={plural(trouble.notes.length, { one: "# note", other: "# notes" })}
          heading={plural(trouble.notes.length, { one: "# note", other: "# notes" })}
        >
          {() => <SentenceList items={trouble.notes} />}
        </FindingsChip>
      );
  }
}
