/** Memoized composer lifecycle: drafts and typing do not follow transcript frames. */
import type { Work } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { memo, type ReactNode, type Ref, useCallback, useRef } from "react";
import { chatUploadPort } from "@/client/api/context-upload-api";
import type { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import {
  Composer,
  type ComposerChatCommand,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";
import type { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import {
  canOpenReference,
  useOpenProjectDocument,
} from "@/features/project/context/open-project-document";
import { useAskTakeover } from "./ask/useAskTakeover";
import { AnchoredCards } from "./ChatCards";
import { ChatComposerToolbar } from "./ChatComposerToolbar";
import { useChatPlace } from "./chat-place";
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
  /** A desktop file drag is over the transcript; the composer is where the files will go. */
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
  agentName,
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
  const place = useChatPlace();
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
  const openReferenceDocument = useOpenProjectDocument(projectId);
  const onOpenReference = useCommittedEvent((reference: { uri: string; documentId: string }) => {
    if (!canOpenReference(reference.uri)) return;
    void openReferenceDocument({ documentId: reference.documentId });
  });

  return (
    <div data-debug-composer={threadId}>
      <Composer
        cards={hasComposerCards ? <AnchoredCards anchor="composer" /> : undefined}
        key={draft.key}
        autoFocus={place === "main"}
        initialDraft={draft.initialDraft}
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
