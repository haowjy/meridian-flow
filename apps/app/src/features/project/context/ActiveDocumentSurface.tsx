/**
 * ActiveDocumentSurface — shared render of "the active context document".
 *
 * One component used by every shell that shows the active document inline:
 * the desktop Context destination (`ContextViewer`) and the chat-screen rail
 * (`ContextRail`). Owning this render in one place is what guarantees the
 * rail and the center pane cannot drift apart — same warm-set editor mount
 * for TRACKED tabs, same viewer host for non-tracked tabs, same placeholder
 * when there is no active tab.
 *
 * Responsibilities:
 *  - Keep the TRACKED `ContextEditorMountHost` mounted whenever there is at
 *    least one tracked tab. If the active tab is itself a viewer (image /
 *    PDF), the host is hidden-but-mounted so flipping back to a tracked tab
 *    is instant and preserves cursor/scroll/Yjs state.
 *  - Render `ContextViewerHost` for the active tab when it is non-tracked.
 *  - Render the placeholder when there is no active tab.
 *
 * Not responsibilities (caller-owned):
 *  - The tab strip (only the center pane has one).
 *  - The per-variant toolbar (e.g. the files-panel reopen affordance —
 *    that's the center pane's responsibility because only it has a files
 *    panel). The active editor's formatting toolbar receives whatever the
 *    caller threads through `toolbarLeading`.
 *
 * Registry owner. Each surface instance must pass a distinct `registryOwner`
 * key so the underlying mount host can retain its open-document set without
 * racing other instances. See `ContextEditorMountHost.registryOwner`.
 */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

import type { ContextTab } from "@/client/stores";

import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextViewerHost } from "./ContextViewerHost";

type EditableContextTab = Extract<ContextTab, { editable: true }>;

export type ActiveDocumentSurfaceProps = {
  projectId: string;
  activeThreadId: string | null;
  /**
   * TRACKED tabs to keep warm (mounted). Pass every tab that should retain
   * its editor session — the host hides inactive tracked tabs but keeps
   * them mounted so a tab switch doesn't tear down Yjs.
   */
  trackedTabs: EditableContextTab[];
  /** The currently visible tab, if any. */
  activeTab: ContextTab | null;
  /**
   * The currently visible tab's documentId. Must equal `activeTab.documentId`
   * when `activeTab` is set; null when no tab is open.
   */
  activeTabId: string | null;
  /**
   * Slot threaded to the ACTIVE editor's formatting toolbar. Hidden warm-set
   * editors do not receive it.
   */
  toolbarLeading?: ReactNode;
  /**
   * Optional override for the no-active-tab placeholder. Defaults to a
   * "Select a document to begin." message. Pass `null` to render nothing.
   */
  placeholder?: ReactNode;
  /**
   * Registry owner key for the editor mount host's session retention. Each
   * concurrently-mounted surface MUST pass a DISTINCT key — same key means
   * `retain()` calls race each other's reconciliation.
   */
  registryOwner: string;
};

export function ActiveDocumentSurface({
  projectId,
  activeThreadId,
  trackedTabs,
  activeTab,
  activeTabId,
  toolbarLeading,
  placeholder,
  registryOwner,
}: ActiveDocumentSurfaceProps) {
  const activeIsTracked = activeTab?.editable === true;
  const resolvedPlaceholder =
    placeholder === undefined ? (
      <ActiveDocumentPlaceholder>
        <Trans>Select a document to begin.</Trans>
      </ActiveDocumentPlaceholder>
    ) : (
      placeholder
    );

  return (
    <>
      {trackedTabs.length > 0 ? (
        // The TRACKED editor host stays mounted while ANY tracked tab is open
        // — even when the active tab is a viewer — so the warm-set editors
        // aren't torn down on a quick image/PDF detour. We hide the whole
        // host when the active tab isn't tracked.
        <div
          className={
            activeIsTracked ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none hidden"
          }
        >
          <ContextEditorMountHost
            projectId={projectId}
            trackedTabs={trackedTabs}
            activeTabId={activeIsTracked ? activeTabId : null}
            toolbarLeading={toolbarLeading}
            registryOwner={registryOwner}
          />
        </div>
      ) : null}
      {activeTab && !activeIsTracked ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContextViewerHost
            projectId={projectId}
            activeThreadId={activeThreadId}
            tab={activeTab}
          />
        </div>
      ) : null}
      {!activeTab ? resolvedPlaceholder : null}
    </>
  );
}

function ActiveDocumentPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
