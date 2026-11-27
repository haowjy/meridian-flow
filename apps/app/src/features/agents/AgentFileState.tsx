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
