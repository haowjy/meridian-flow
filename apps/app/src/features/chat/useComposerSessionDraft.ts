/** Mounts a pane on the shared per-tab authoring owner. */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { type ComposerDraftScope, composerSessionDraft } from "@/client/composer-drafts";

export function useComposerSessionDraft(accountId: string, scope: ComposerDraftScope) {
  const owner = useMemo(
    () => composerSessionDraft(accountId, scope),
    [accountId, scope.kind, scope.id],
  );
  // Only lifecycle transfers publish. Ordinary typing never remounts the editor.
  const version = useSyncExternalStore(owner.subscribe, owner.getVersion, owner.getVersion);
  useEffect(() => {
    window.addEventListener("pagehide", owner.flush);
    return () => {
      window.removeEventListener("pagehide", owner.flush);
      owner.flush();
    };
  }, [owner]);
  return {
    key: `${owner.key}:${version}`,
    initialDraft: owner.initialDraft,
    updateDraft: owner.updateDraft,
    handoff: owner.handoff,
    handoffSubmitted: owner.handoffSubmitted,
  };
}
