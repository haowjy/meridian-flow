import { useEffect, useMemo, useSyncExternalStore } from "react";
import { type ComposerDraftScope, composerSessionDraft } from "@/client/composer-drafts";

export function useComposerSessionDraft(accountId: string, scope: ComposerDraftScope) {
  const owner = useMemo(
    () => composerSessionDraft(accountId, scope),
    [accountId, scope.kind, scope.id],
  );
  useSyncExternalStore(owner.subscribe, owner.getVersion, owner.getVersion);
  useEffect(() => {
    window.addEventListener("pagehide", owner.flush);
    return () => {
      window.removeEventListener("pagehide", owner.flush);
      owner.flush();
    };
  }, [owner]);
  return {
    key: owner.key,
    notices: owner.notices,
    dismissNotice: owner.dismissNotice,
    initialDraft: owner.initialDraft,
    externalChange: owner.externalChange(),
    chatId: owner.chatId,
    attachedAbout: owner.attachedAbout,
    setAttachedAbout: owner.setAttachedAbout,
    setProject: owner.setProject,
    updateDraft: owner.updateDraft,
    handoffCreated: owner.handoffCreated,
    handoffSubmitted: owner.handoffSubmitted,
  };
}
