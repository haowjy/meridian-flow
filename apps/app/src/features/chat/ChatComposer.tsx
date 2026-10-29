/** Memoized composer lifecycle: drafts and typing do not follow transcript frames. */
import type { Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { memo, type ReactNode, type Ref, useCallback, useRef } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import type { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import {
  Composer,
  type ComposerChatCommand,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";
import type { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import {
  useCanOpenChatReference,
  useOpenChatDocument,
} from "@/features/project/context/open-chat-document";
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
  agentName: string;
  running: boolean;
  stopStatus: ChatStop["status"];
  generating: boolean;
  writeMode: AiWriteMode;
  onWriteModeChange: (mode: AiWriteMode) => void;
  composerStrip?: ReactNode;
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
  agentName,
  running,
  stopStatus,
  generating,
  writeMode,
  onWriteModeChange,
  composerStrip,
  availableSkills,
  referenceCatalog,
  chatCommands,
  hasComposerCards,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const draft = useComposerSessionDraft(accountId, { kind: "chat", id: threadId });
  const composer = useRef<ComposerHandle | null>(null);
  const composerRef = useCallback(
    (handle: ComposerHandle | null) => {
      composer.current = handle;
      if (typeof ref === "function") ref(handle);
      else if (ref) ref.current = handle;
    },
    [ref],
  );
  // While an ask is open it takes the box's place; nothing runs, so Stop is not offered.
  const takeover = useAskTakeover(accountId, threadId, composer);
  const dock = useDraftDock({ threadId, generating, active });
  const openReferenceDocument = useOpenChatDocument(projectId);
  const canOpenReference = useCanOpenChatReference();
  const onOpenReference = useCommittedEvent((reference: { uri: string; documentId: string }) => {
    if (!canOpenReference(reference.uri)) return;
    void openReferenceDocument({ documentId: reference.documentId, disposition: "current" });
  });

  return (
    <div data-debug-composer={threadId}>
      <Composer
        cards={hasComposerCards ? <AnchoredCards anchor="composer" /> : undefined}
        key={draft.key}
        initialDraft={draft.initialDraft}
        onDraftChange={draft.updateDraft}
        onOpenReference={onOpenReference}
        ref={composerRef}
        takeover={takeover}
        variant="pinned"
        attached={
          <>
            {composerStrip ? (
              <div className="mx-[var(--chat-space-block)] rounded-t-composer-pinned border border-b-0 border-composer-border bg-composer-surface">
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
        uploadPort={uploadIntakePort}
        uploadScope={{ kind: "chat", projectId, chatId }}
        onSubmit={onSubmit}
        onStop={onStop}
        toolbarLeft={
          activeWork ? (
            <ChatComposerToolbar
              projectId={projectId}
              threadId={threadId}
              work={activeWork}
              agentName={agentName}
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
