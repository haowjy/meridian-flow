import type { Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { memo, type ReactNode, type Ref, useCallback, useEffect, useRef } from "react";
import type { ComposerSubmitEnvelope } from "@/client/chat-submissions/composer-document";
import type { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import type { ComposerAgentControlProps } from "@/features/agents/ComposerAgentControl";
import { Composer, type ComposerChatCommand, type ComposerHandle } from "@/features/chat/composer";
import { chatUploadPort } from "@/features/chat/composer/chat-upload-port";
import type { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { mainTabStripHasFocus, usePanePlace } from "@/features/project/pane-place";
import { useOpenPlacedDocument } from "@/features/project/review-launch";
import { useAskTakeover } from "./ask/useAskTakeover";
import { AnchoredCards } from "./ChatCards";
import { ChatComposerToolbar } from "./ChatComposerToolbar";
import { DraftDock } from "./DraftDock";
import type { ChatStop } from "./useChatStop";
import { useCommittedEvent } from "./useCommittedEvent";
import { useComposerSessionDraft } from "./useComposerSessionDraft";
import { useDraftDock } from "./useDraftDock";

type ChatComposerProps = {
  ref: Ref<ComposerHandle>;
  threadId: string;
  projectId: string;
  accountId: string;
  chatId: string;
  active: boolean;
  activeWork: Work | null;
  agent: ComposerAgentControlProps;
  running: boolean;
  stopStatus: ChatStop["status"];
  generating: boolean;
  writeMode: AiWriteMode;
  onWriteModeChange: (mode: AiWriteMode) => void;
  composerStrip?: ReactNode;
  fileDropActive: boolean;
  availableSkills: ReturnType<typeof useThreadAvailableSkills>["skills"];
  referenceCatalog: ReturnType<typeof useReferenceBrowserCatalog>;
  chatCommands: readonly ComposerChatCommand[];
  hasComposerCards: boolean;
  onSubmit: (envelope: ComposerSubmitEnvelope) => Promise<boolean>;
  onStop: () => void;
};

function ChatComposerComponent({
  ref,
  threadId,
  projectId,
  accountId,
  chatId,
  active,
  activeWork,
  agent,
  running,
  stopStatus,
  generating,
  writeMode,
  onWriteModeChange,
  composerStrip,
  fileDropActive,
  availableSkills,
  referenceCatalog,
  chatCommands,
  hasComposerCards,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const place = usePanePlace();
  const draft = useComposerSessionDraft(accountId, { kind: "chat", id: threadId });
  const { setProject } = draft;
  useEffect(() => setProject(projectId), [setProject, projectId]);
  const composer = useRef<ComposerHandle | null>(null);
  const composerRef = useCallback(
    (handle: ComposerHandle | null) => {
      composer.current = handle;
      if (typeof ref === "function") ref(handle);
      else if (ref) ref.current = handle;
    },
    [ref],
  );
  const takeover = useAskTakeover(accountId, threadId, composer);
  const dock = useDraftDock({ threadId, generating, active });
  const openReferenceDocument = useOpenPlacedDocument(projectId);
  const onOpenReference = useCommittedEvent((reference: { uri: string; documentId: string }) => {
    void openReferenceDocument(reference.documentId);
  });

  return (
    <div data-debug-composer={threadId}>
      <Composer
        cards={hasComposerCards ? <AnchoredCards anchor="composer" /> : undefined}
        key={draft.key}
        autoFocus={place === "main" && !mainTabStripHasFocus()}
        initialDraft={draft.initialDraft}
        externalChange={draft.externalChange}
        onDraftChange={draft.updateDraft}
        onOpenReference={onOpenReference}
        ref={composerRef}
        takeover={takeover}
        fileDropActive={fileDropActive}
        attached={
          <>
            {composerStrip ? (
              <div className="mx-[var(--chat-space-block)] rounded-t-xl border border-b-0 border-border bg-card">
                {composerStrip}
              </div>
            ) : null}
            <DraftDock dock={dock} />
          </>
        }
        running={running}
        stopStatus={stopStatus}
        referenceCatalog={referenceCatalog}
        availableSkills={availableSkills}
        commands={chatCommands}
        uploadPort={chatUploadPort}
        uploadScope={{ kind: "chat", projectId, chatId }}
        onSubmit={onSubmit}
        onStop={onStop}
        toolbarLeft={
          activeWork ? (
            <ChatComposerToolbar
              projectId={projectId}
              threadId={threadId}
              work={activeWork}
              agent={agent}
              writeMode={writeMode}
              onWriteModeChange={onWriteModeChange}
            />
          ) : undefined
        }
      />
    </div>
  );
}

export const ChatComposer = memo(ChatComposerComponent);
ChatComposer.displayName = "ChatComposer";
