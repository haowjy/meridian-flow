import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  type AgentFileStatus,
  type AgentLevel,
  agentsLocationOf,
} from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, EyeOff, FileCog, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { invalidateAgentReads, useAgentFiles } from "@/client/query/useAgentFiles";
import type { OpenDocument } from "@/client/stores";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import {
  useAccountId,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
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
 * Mars's verdict on one Agent or skill file: whose level it is at, whether chats can use it and,
 * if not, Mars's reasons; and what it hides or what hides it.
 */
export function AgentFileStatusNotice({
  file,
  action,
  className,
}: {
  file: AgentFileStatus;
  /** Its package's Save state and Save. */
  action?: ReactNode;
  className?: string;
}) {
  useLingui();
  const agent = file.kind === "agent";
  const level =
    file.level === "project"
      ? agent
        ? t`Project Agent`
        : t`Project skill`
      : file.level === "user"
        ? agent
          ? t`Your Agent, in every project`
          : t`Your skill, in every project`
        : agent
          ? t`Built-in Agent, read-only`
          : t`Built-in skill, read-only`;
  const hides = file.shadows.length
    ? listOf(file.shadows.map((below) => whose(below, file.slug)))
    : null;
  const unavailable = file.unavailableReasons.length > 0;
  const status = file.hiddenBy
    ? t`Not used: ${whose(file.hiddenBy, file.slug)} hides it.`
    : unavailable
      ? file.savedVersionInUse
        ? t`Your latest edit isn't in use; the last saved version is:`
        : hides
          ? t`Unavailable, and it still hides ${hides}:`
          : t`Unavailable:`
      : !file.saved
        ? t`Not in use until it is saved.`
        : `${
            file.pickable
              ? t`Available.`
              : agent
                ? t`Available to other Agents; it isn't in the picker.`
                : t`Available to Agents; it isn't in the / menu.`
          }${hides ? ` ${t`It hides ${hides}.`}` : ""}`;
  return (
    <DocumentNotice
      className={className}
      action={action}
      icon={
        file.hiddenBy ? (
          <EyeOff aria-hidden className="size-4" />
        ) : unavailable ? (
          <TriangleAlert aria-hidden className="size-4 text-destructive" />
        ) : file.saved ? (
          <CircleCheck aria-hidden className="size-4" />
        ) : (
          <FileCog aria-hidden className="size-4" />
        )
      }
    >
      <span className="font-medium text-foreground">{level}.</span> {status}
      {unavailable ? (
        <span className="mt-1 block space-y-0.5 text-foreground">
          {file.unavailableReasons.map((reason) => (
            <span key={reason} className="block whitespace-pre-line break-words">
              {reason}
            </span>
          ))}
        </span>
      ) : null}
    </DocumentNotice>
  );
}

/**
 * An open file of an Agents level, at the end of its toolbar row: what keeps it from use (its
 * problems, or a level above that hides it), its notes, and its package's Save state with Save.
 * Read again each time the server acknowledges the writer's edits, so it follows the typing. A
 * file with nothing to say shows nothing.
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
      documentId={document.documentId}
      scheme={document.scheme}
      path={document.path}
      touch={touch}
    />
  ) : null;
}

function LevelFileState({
  projectId,
  documentId,
  scheme,
  path,
  touch,
}: {
  projectId: string;
  documentId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  touch: boolean;
}) {
  useLingui();
  const files = useAgentFiles(projectId);
  useReadAgainOnSave(projectId, documentId);
  const at = agentsLocationOf(scheme, path.replace(/^\//, ""));
  const file = agentFileAt(files?.files ?? null, scheme, path);
  if (!at || !files) return null;
  const pkg = { level: at.level, folder: packageFolderOf(at.path) };
  const status = statusOf(files.packages, pkg);
  const trouble = file ? fileTrouble(file, status) : null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-agent-file-state>
      {file && trouble ? <TroubleChip file={file} trouble={trouble} touch={touch} /> : null}
      <PackageSave projectId={projectId} pkg={pkg} status={status} look="file" />
    </span>
  );
}

function TroubleChip({
  file,
  trouble,
  touch,
}: {
  file: AgentFileStatus;
  trouble: FileTrouble;
  touch: boolean;
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
          sub={
            file.saved
              ? t`The last Save left it out. Fix these and save again.`
              : t`Save leaves it out until these are fixed.`
          }
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
          sub={t`New chats use the last good save of ${name} until these are fixed and it is saved again.`}
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
          sub={t`${name} works and saves.`}
        >
          {() => <SentenceList items={trouble.notes} />}
        </FindingsChip>
      );
  }
}

/** Each time the server has every edit of this document, the verdicts are read again. */
function useReadAgainOnSave(projectId: string, documentId: string) {
  const registry = useLiveDocumentSessionRegistry();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  useEffect(() => {
    const lease = registry.admit(projectId as ProjectId, documentId as DocumentId);
    const owner = `agent-file-notice:${documentId}`;
    registry.retain(owner, [lease]);
    let saved: boolean | null = null;
    const stop = registry.get(lease).subscribe((snapshot) => {
      const now = snapshot.serverHasLocalChanges;
      if (saved === false && now) void invalidateAgentReads(queryClient, projectId, accountId);
      saved = now;
    });
    return () => {
      stop();
      registry.release(owner);
    };
  }, [registry, queryClient, projectId, documentId, accountId]);
}
