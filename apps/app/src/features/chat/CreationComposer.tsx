/** Shared pinned new-chat composer for the main, the side, and the phone. */
import { t } from "@lingui/core/macro";
import { isWorkArchived } from "@meridian/contracts/works";
import type { JSONContent } from "@tiptap/core";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { chatUploadPort } from "@/client/api/context-upload-api";
import type { AttachedAbout } from "@/client/composer-drafts";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import { useSelectionAvailableSkills } from "@/client/query/useAvailableSkills";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { Composer, type ComposerDraftChange, type ComposerHandle } from "@/components/app/composer";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { NewThreadComposerToolbar } from "@/features/project/chat/NewThreadComposerToolbar";
import { FolderMenuContext, type FolderMenuHost } from "@/features/project/context/FolderMenu";
import {
  canOpenReference,
  useOpenProjectDocument,
} from "@/features/project/context/open-project-document";
import { useWorkScope } from "@/features/project/use-work-scope";
import { DeletedChatCard } from "./DeletedChatCard";
import { useCreationComposer } from "./useCreationComposer";

export function CreationComposer({
  projectId,
  about = null,
  newChatFocusRequestId = null,
  onNewChatFocusHandled,
  onAboutChange,
}: {
  projectId: string;
  /** The document a new chat beside it is about: attached while the writer has written nothing. */
  about?: string | null;
  /** What the new chat is about as its draft stands, for the side's name. */
  onAboutChange?: (about: NewChatAbout) => void;
  /**
   * A one-shot New chat focus intent for the pinned composer, supplied by the
   * host (project routing owns the request; this composer stays unaware of
   * project routing beyond this prop).
   */
  newChatFocusRequestId?: number | null;
  onNewChatFocusHandled?: (id: number) => void;
}) {
  const creation = useCreationComposer(projectId);
  const composerRef = useRef<ComposerHandle>(null);
  // An explicit New chat focuses the empty composer showing it. The frame lets a just-revealed side drop `inert` first. A composer that
  // mounts fresh already sees the request id in this same render, so mount
  // timing never races the host publishing it.
  useEffect(() => {
    if (newChatFocusRequestId == null) return;
    requestAnimationFrame(() => composerRef.current?.focus());
    onNewChatFocusHandled?.(newChatFocusRequestId);
  }, [newChatFocusRequestId, onNewChatFocusHandled]);
  const works = useWorks(projectId);
  const agents = useAgentCatalog(true, projectId);
  const choices = creation.choices;
  const defaultAgent = agents.agents?.find(
    (agent) => agent.ownership === "system" && agent.slug === DEFAULT_AGENT_SLUG,
  );
  const agent = choices?.agent ?? defaultAgent ?? null;
  const availableSkills = useSelectionAvailableSkills(agent?.selection ?? null, projectId);
  // A new chat takes the Work scope unless the writer picked another Work for this draft.
  const scope = useWorkScope(projectId);
  const workId = choices?.workId ?? scope.workId;
  const selected = workId
    ? workFromSnapshot(
        works.noWork ? { works: works.works ?? [], noWork: works.noWork } : null,
        workId,
      )
    : null;
  // An archived Work refuses new chats, so it is never the new chat's Work.
  const work = selected && (selected.isNoWork || !isWorkArchived(selected)) ? selected : null;
  const references = useReferenceBrowserCatalog(
    projectId,
    work?.id,
    t`Reference a file`,
    null,
    creation.draft.chatId,
  );
  const noteDraft = useAttachAbout(composerRef, creation.draft, references, about, onAboutChange);
  const openDocument = useOpenProjectDocument(projectId);
  const folders = useMemo<FolderMenuHost>(
    () => ({
      projectId,
      openDocument: (documentId) => void openDocument({ documentId }),
    }),
    [openDocument, projectId],
  );
  // The Work's default shows until the writer picks a mode here, and only a
  // picked mode is sent: a stale default from another tab never overwrites a newer one.
  const writeMode = choices?.aiWriteMode ?? work?.defaultAiWriteMode ?? "direct";
  const context =
    agent && work
      ? {
          workId: work.id,
          workAiWriteMode: work.defaultAiWriteMode,
          ...(choices?.aiWriteMode ? { aiWriteMode: choices.aiWriteMode } : {}),
          agent,
        }
      : undefined;
  const unavailableWork =
    (works.status === "ready" || works.status === "empty") && workId !== null && !work;
  const catalogAgent = agents.agents?.find(
    (item) => item.selection.catalogEntryId === agent?.selection.catalogEntryId,
  );
  const unavailableAgent =
    (agents.status === "ready" || agents.status === "empty") &&
    (!agent ||
      !catalogAgent ||
      (catalogAgent.selection.definitionRevisionId === agent.selection.definitionRevisionId &&
        catalogAgent.unavailableReasons.length > 0));
  const unavailableChoice = unavailableWork || unavailableAgent;
  const unavailableMessage = !unavailableChoice
    ? null
    : unavailableWork
      ? t`Your selected Work is unavailable. Choose another Work, or None.`
      : t`Your selected Agent is unavailable. Choose another Agent.`;
  const worksReady = works.status === "ready" || works.status === "empty";
  const agentsReady = agents.status === "ready" || agents.status === "empty";
  const choicesReady = worksReady && agentsReady && !unavailableChoice;
  return (
    <FolderMenuContext.Provider value={folders}>
      <Composer
        cards={
          creation.draft.notices.length > 0
            ? creation.draft.notices.map((notice) => (
                <DeletedChatCard
                  key={notice.threadId}
                  notice={notice}
                  onDismiss={() => creation.draft.dismissNotice(notice.threadId)}
                />
              ))
            : undefined
        }
        key={creation.draft.key}
        initialDraft={creation.draft.initialDraft}
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
          if (!canOpenReference(reference.uri)) return;
          void openDocument({ documentId: reference.documentId });
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
            writeMode={writeMode}
            onAgentChange={(next) => creation.updateChoices({ agent: next })}
            // A mode picked for one Work is not carried to another.
            onWorkChange={(selected) =>
              creation.updateChoices({ workId: selected.id, aiWriteMode: undefined })
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

/**
 * What a new chat beside a document is about, as its draft stands: the side's name says it.
 * `follows`: the draft is empty or the chip this composer put there, untouched, so it moves with
 * the document beside. A label: the writer wrote around that chip. Null: the chip is gone.
 */
export type NewChatAbout = "follows" | { label: string } | null;

/**
 * A new chat beside a document starts with that document attached. The writer's own draft is
 * theirs: the chip replaces only an empty draft or the chip this hook put there last, never an
 * upload or a chip the writer picked. Which chip it put there is kept with the draft, so a
 * remounted or reloaded composer still knows. Nothing here takes focus.
 */
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

/** Whether the draft is the attached chip alone, holds it among the writer's words, or lost it. */
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
