import { t } from "@lingui/core/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { NO_OVERRIDES } from "@meridian/contracts/threads";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import type { JSONContent } from "@tiptap/core";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { chatUploadPort } from "@/client/api/context-upload-api";
import type { AttachedAbout } from "@/client/composer-drafts";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useSelectionAvailableSkills } from "@/client/query/useAvailableSkills";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { Composer, type ComposerDraftChange, type ComposerHandle } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import { DEFAULT_AGENT_SLUG, pickableAgents } from "@/features/agents";
import { boundAgentRow } from "@/features/agents/creation-agent";
import { useNewChatConnectionMarks } from "@/features/connections/NewChatConnectionMarks";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { NewThreadComposerToolbar } from "@/features/project/chat/NewThreadComposerToolbar";
import { FolderMenuContext, type FolderMenuHost } from "@/features/project/context/FolderMenu";
import { useOpenPlacedDocument } from "@/features/project/review-launch";
import { useShellTreeVersion } from "@/features/project/tree-version";
import { useWorkScope } from "@/features/project/use-work-scope";
import { DeletedChatCard } from "./DeletedChatCard";
import { useCreationComposer } from "./useCreationComposer";

function newestPrimaryThread(threads: ThreadListItem[] | null): ThreadListItem | null {
  let newest: ThreadListItem | null = null;
  for (const thread of threads ?? [])
    if (thread.kind === "primary" && (!newest || thread.createdAt > newest.createdAt))
      newest = thread;
  return newest;
}

export function CreationComposer({
  projectId,
  about = null,
  newChatFocusRequestId = null,
  onNewChatFocusHandled,
  onAboutChange,
}: {
  projectId: string;
  about?: string | null;
  onAboutChange?: (about: NewChatAbout) => void;
  newChatFocusRequestId?: number | null;
  onNewChatFocusHandled?: (id: number) => void;
}) {
  const creation = useCreationComposer(projectId);
  const composerRef = useRef<ComposerHandle>(null);
  useEffect(() => {
    if (newChatFocusRequestId == null) return;
    requestAnimationFrame(() => composerRef.current?.focus());
    onNewChatFocusHandled?.(newChatFocusRequestId);
  }, [newChatFocusRequestId, onNewChatFocusHandled]);
  const works = useWorks(projectId);
  const connectionMarks = useNewChatConnectionMarks(projectId);
  const agents = useAgentCatalog(true, projectId);
  const choices = creation.choices;
  const pickable = pickableAgents(agents.agents ?? []);
  const { threads } = useProjectThreads(projectId);
  const newest = newestPrimaryThread(threads);
  const defaultAgent =
    (newest &&
      boundAgentRow(pickable, {
        name: newest.agentName,
        definitionRevisionId: newest.agentDefinitionRevisionId,
      })) ??
    pickable.find((agent) => agent.slug === DEFAULT_AGENT_SLUG);
  const agent = choices?.agent ?? defaultAgent ?? null;
  const availableSkills = useSelectionAvailableSkills(agent?.selection ?? null, projectId);
  const scope = useWorkScope(projectId);
  const workId = choices?.workId ?? scope.workId;
  const selected = workId
    ? workFromSnapshot(
        works.noWork ? { works: works.works ?? [], noWork: works.noWork } : null,
        workId,
      )
    : null;
  const work = selected && (selected.isNoWork || !isWorkArchived(selected)) ? selected : null;
  const references = useReferenceBrowserCatalog(
    projectId,
    work?.id,
    t`Reference a file`,
    null,
    creation.draft.chatId,
  );
  const noteDraft = useAttachAbout(composerRef, creation.draft, references, about, onAboutChange);
  const openDocument = useOpenPlacedDocument(projectId);
  const folders = useMemo<FolderMenuHost>(
    () => ({
      projectId,
      openDocument: (documentId) => void openDocument(documentId),
    }),
    [openDocument, projectId],
  );
  const writeMode = choices?.aiWriteMode ?? work?.defaultAiWriteMode ?? "direct";
  const shell = useShellTreeVersion();
  const shownDraft = (work: Work) =>
    shell?.work?.id === work.id && shell.showing === "draft" ? shell.draftId : work.draftId;
  const context =
    agent && work
      ? {
          workId: work.id,
          workAiWriteMode: work.defaultAiWriteMode,
          workDraftId: work.isNoWork ? null : shownDraft(work),
          ...(choices?.aiWriteMode ? { aiWriteMode: choices.aiWriteMode } : {}),
          agent,
          overrides: choices?.overrides ?? NO_OVERRIDES,
        }
      : undefined;
  const unavailableWork =
    (works.status === "ready" || works.status === "empty") && workId !== null && !work;
  const catalogAgent = agents.agents?.find((item) => item.slug === agent?.selection.slug);
  const unavailableAgent =
    (agents.status === "ready" || agents.status === "empty") &&
    (!catalogAgent || catalogAgent.unavailableReasons.length > 0);
  const unavailableChoice = unavailableWork || unavailableAgent;
  const unavailableMessage = !unavailableChoice
    ? null
    : unavailableWork
      ? t`Selected Work unavailable`
      : t`Selected Agent unavailable`;
  const worksReady = works.status === "ready" || works.status === "empty";
  const agentsReady = agents.status === "ready" || agents.status === "empty";
  const choicesReady = worksReady && agentsReady && !unavailableChoice;
  return (
    <FolderMenuContext.Provider value={folders}>
      <Composer
        cards={
          creation.draft.notices.length > 0 || connectionMarks ? (
            <>
              {creation.draft.notices.map((notice) => (
                <DeletedChatCard
                  key={notice.threadId}
                  notice={notice}
                  onDismiss={() => creation.draft.dismissNotice(notice.threadId)}
                />
              ))}
              {connectionMarks}
            </>
          ) : undefined
        }
        key={creation.draft.key}
        initialDraft={creation.draft.initialDraft}
        externalChange={creation.draft.externalChange}
        ref={composerRef}
        autoFocus={false}
        onSubmit={async (envelope) =>
          Boolean(choicesReady && context && creation.submit(envelope, context))
        }
        onDraftChange={(change) => {
          creation.draft.updateDraft(change);
          noteDraft(change);
        }}
        referenceCatalog={references}
        availableSkills={availableSkills.skills}
        onOpenReference={(reference) => {
          void openDocument(reference.documentId);
        }}
        uploadPort={chatUploadPort}
        uploadScope={{ kind: "chat", projectId, chatId: creation.draft.chatId }}
        submitDisabled={!choicesReady}
        submitDisabledReason={
          unavailableMessage ??
          (!worksReady
            ? t`Loading Work`
            : !agentsReady
              ? agents.isError
                ? t`Couldn't load agents.`
                : t`Loading agents…`
              : undefined)
        }
        toolbarLeft={
          <NewThreadComposerToolbar
            projectId={projectId}
            work={work}
            selectedWorkId={workId}
            works={works.works ?? []}
            noWork={works.noWork}
            worksStatus={works.isError ? "error" : worksReady ? "ready" : "loading"}
            agent={agent}
            overrides={choices?.overrides ?? NO_OVERRIDES}
            writeMode={writeMode}
            onAgentChange={(next) =>
              creation.updateChoices({ agent: next.agent, overrides: next.overrides })
            }
            onWorkChange={(selected) =>
              creation.updateChoices({ workId: selected.id, aiWriteMode: writeMode })
            }
            onWriteModeChange={(mode) => creation.updateChoices({ aiWriteMode: mode })}
            onRetryWorks={works.refetch}
          />
        }
      />
      {works.isError ? (
        <InlineErrorRow message={t`Work couldn’t load`} onRetry={works.refetch} />
      ) : null}
      {unavailableMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailableMessage}
        </p>
      ) : null}
    </FolderMenuContext.Provider>
  );
}

export type NewChatAbout = "follows" | { label: string } | null;

function useAttachAbout(
  composerRef: RefObject<ComposerHandle | null>,
  draft: Pick<
    ReturnType<typeof useCreationComposer>["draft"],
    "attachedAbout" | "setAttachedAbout"
  >,
  references: ReferenceBrowserCatalog | null,
  about: string | null,
  onAboutChange: ((about: NewChatAbout) => void) | undefined,
) {
  const { attachedAbout, setAttachedAbout } = draft;
  const report = useRef(onAboutChange);
  report.current = onAboutChange;
  useEffect(() => {
    if (!about || !references) return;
    const attach = () => {
      const handle = composerRef.current;
      if (!handle) return false;
      const row = references.resolveReference({ kind: "file", id: about });
      if (row?.kind !== "file") return false;
      const reference = row.action.reference;
      if (handle.startWith(reference, row.fileKind, attachedAbout()?.documentId ?? null)) {
        setAttachedAbout({ documentId: about, label: reference.label });
        report.current?.("follows");
      } else report.current?.(aboutOf(handle.snapshot().doc, attachedAbout()));
      return true;
    };
    if (attach()) return;
    const stop = references.port.subscribe(() => {
      if (attach()) stop();
    });
    return stop;
  }, [about, references, composerRef, attachedAbout, setAttachedAbout]);
  return useCallback(
    (change: ComposerDraftChange) => {
      const attached = attachedAbout();
      if (attached) report.current?.(aboutOf(change.snapshot.doc, attached));
    },
    [attachedAbout],
  );
}

function aboutOf(doc: JSONContent, chip: AttachedAbout | null): NewChatAbout {
  if (!chip) return null;
  const isChip = (node: JSONContent | undefined) =>
    node?.type === "composerReference" &&
    (node.attrs?.reference as { kind?: string; documentId?: string } | undefined)?.documentId ===
      chip.documentId;
  const only = doc.content?.length === 1 ? doc.content[0] : undefined;
  if (only?.type === "paragraph" && only.content?.length === 1 && isChip(only.content[0]))
    return "follows";
  const holds = (node: JSONContent): boolean => isChip(node) || (node.content ?? []).some(holds);
  return holds(doc) ? { label: chip.label } : null;
}
