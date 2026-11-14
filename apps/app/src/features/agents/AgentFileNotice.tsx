import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  type AgentFileStatus,
  type AgentLevel,
  agentsLocationOf,
} from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, EyeOff, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { invalidateAgentReads, useAgentFiles } from "@/client/query/useAgentFiles";
import type { OpenDocument } from "@/client/stores";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import {
  useAccountId,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";

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

/** What a row in the Agents tab says after its name: only what keeps it from use. */
export function agentFileMark(file: AgentFileStatus | null | undefined): string | undefined {
  if (!file) return undefined;
  if (file.unavailableReasons.length > 0) return t`Unavailable`;
  return file.hiddenBy ? t`Hidden` : undefined;
}

/**
 * Mars's verdict on one Agent or skill file: whose level it is at, whether chats can use it and,
 * if not, Mars's reasons; and what it hides or what hides it.
 */
export function AgentFileStatusNotice({
  file,
  className,
}: {
  file: AgentFileStatus;
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
      ? hides
        ? t`Unavailable, and it still hides ${hides}:`
        : t`Unavailable:`
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
      icon={
        file.hiddenBy ? (
          <EyeOff aria-hidden className="size-4" />
        ) : unavailable ? (
          <TriangleAlert aria-hidden className="size-4 text-destructive" />
        ) : (
          <CircleCheck aria-hidden className="size-4" />
        )
      }
    >
      <span className="font-medium text-foreground">{level}.</span> {status}
      {unavailable ? (
        <span className="mt-1 block space-y-0.5 text-foreground">
          {file.unavailableReasons.map((reason) => (
            <span key={reason} className="block">
              {reason}
            </span>
          ))}
        </span>
      ) : null}
    </DocumentNotice>
  );
}

/**
 * Under an open Agent or skill file's path bar: Mars's verdict, read again each time the server
 * acknowledges the writer's edits, so the verdict follows the typing.
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
  const file = agentFileAt(files, scheme, path);
  useReadAgainOnSave(projectId, documentId);
  if (!file) return null;
  return (
    <div className={className} data-agent-file-notice>
      <AgentFileStatusNotice file={file} />
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
      if (saved === false && now) invalidateAgentReads(queryClient, projectId, accountId);
      saved = now;
    });
    return () => {
      stop();
      registry.release(owner);
    };
  }, [registry, queryClient, projectId, documentId, accountId]);
}
