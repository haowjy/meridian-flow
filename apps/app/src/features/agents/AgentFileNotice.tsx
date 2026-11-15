import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
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
import { PackageSave } from "./PackageSave";
import { packageFolderOf, packageLabel, statusOf, usePackageSaves } from "./package-save";

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

/** What a row says after its name of what keeps it from use: a built-in's, or the last word of a level's file. */
export function agentFileMark(file: AgentFileStatus | null | undefined): string | undefined {
  if (!file) return undefined;
  if (file.unavailableReasons.length > 0)
    return file.savedVersionInUse ? t`Edit not in use` : t`Unavailable`;
  return file.hiddenBy ? t`Hidden` : undefined;
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
 * Under an open file of an Agents level: Mars's verdict on an Agent or skill file, and its
 * package's Save state with Save, read again each time the server acknowledges the writer's
 * edits, so both follow the typing. Another file of a level (`mars.toml`) shows only the Save.
 */
export function AgentFileNotice({
  projectId,
  document,
  className = "px-4 pt-3",
}: {
  projectId: string;
  document: OpenDocument;
  className?: string;
}) {
  const inLevel =
    document.kind === "tracked" &&
    agentsLocationOf(document.scheme, document.path.replace(/^\//, "")) !== null;
  return inLevel && document.kind === "tracked" ? (
    <LevelFileNotice
      projectId={projectId}
      documentId={document.documentId}
      scheme={document.scheme}
      path={document.path}
      className={className}
    />
  ) : null;
}

function LevelFileNotice({
  projectId,
  documentId,
  scheme,
  path,
  className,
}: {
  projectId: string;
  documentId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  className: string;
}) {
  const files = useAgentFiles(projectId);
  const file = agentFileAt(files?.files ?? null, scheme, path);
  useReadAgainOnSave(projectId, documentId);
  const saves = usePackageSaves(projectId);
  const at = agentsLocationOf(scheme, path.replace(/^\//, ""));
  if (!at || file === undefined) return null;
  const pkg = { level: at.level, folder: packageFolderOf(at.path) };
  const status = statusOf(files?.packages, pkg);
  const save = <PackageSave projectId={projectId} pkg={pkg} status={status} look="file" />;
  // A level's file that defines no Agent or skill says only its package's state, when it has one.
  if (!file && !saves.shows(pkg, status)) return null;
  const label = packageLabel(pkg);
  return (
    <div className={className} data-agent-file-notice>
      {file ? (
        <AgentFileStatusNotice file={file} action={save} />
      ) : (
        <DocumentNotice icon={<FileCog aria-hidden className="size-4" />} action={save}>
          <Trans>Part of {label}.</Trans>
        </DocumentNotice>
      )}
    </div>
  );
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
