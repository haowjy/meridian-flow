/**
 * ContextSidebar — right-side project rail summarizing work context sections
 * and deferred artifact surfaces. It is visual chrome only; data ownership
 * stays with the project/context feature hooks.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Sparkles } from "lucide-react";
import { useState } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { Section } from "@/features/chat/ThreadDocumentList";
import { ThreadDocumentSections } from "@/features/chat/ThreadDocumentSections";

import { RailHeader } from "./RailHeader";
import { ResultsRailBody, useResultsRailModel } from "./ResultsRailSection";
import { ResultViewerOverlay } from "./ResultViewerOverlay";
import { SidebarSectionLabel } from "./SidebarSectionLabel";

/**
 * Thread-context rail (Chat destination, right edge).
 *
 * Three sections, labels locked by the project design brief:
 *
 *   1. **Uploads** — files the user uploaded into this chat
 *      (`thread_documents`, the `.uploads` namespace).
 *   2. **Recent**  — documents the agent recently read/touched
 *      (`turn_document_touches`, deduped by document).
 *   3. **Results** — promoted artifacts the agent produced (project-scoped,
 *      not thread-scoped). Owns its own state machine in `ResultsRailSection`
 *      and reuses the existing read-only viewers in a modal overlay.
 *
 * Both live document sections share one `DocumentRailSection` primitive
 * that owns the loading/empty/error/disabled state machine and the count
 * suppression rules. Counts only render in `empty`/`ready` — anything else
 * (disabled, loading, error) hides the count so we never fabricate `0`
 * over the top of a hint that says "couldn't load". The Results section
 * mirrors the same honest count discipline.
 */
export type ContextSidebarProps = {
  /** Active thread; when null, sections render their disabled empty state. */
  threadId: string | null;
  /** Active project; powers the Results section (project-scoped, not thread-scoped). */
  projectId: string | null;
  onClose: () => void;
};

export function ContextSidebar({ threadId, projectId, onClose }: ContextSidebarProps) {
  // Results live at the project scope (artifact persistence outlives any
  // single chat), so the rail tracks `projectId` independently of the
  // thread state. Open-result is local state — at most one viewer at a time.
  const [openResult, setOpenResult] = useState<ProjectResultItem | null>(null);
  const results = useResultsRailModel(projectId);

  return (
    <aside aria-label={t`Thread context`} className="flex h-full min-h-0 w-full flex-col">
      <RailHeader onClose={onClose} closeLabel={t`Collapse context  ]`} side="right">
        <SidebarSectionLabel>
          <Trans>Context</Trans>
        </SidebarSectionLabel>
      </RailHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        <ThreadDocumentSections threadId={threadId} />
        <Section
          title={t`Results`}
          icon={<Sparkles className="size-3.5" />}
          count={results.count}
          defaultOpen
        >
          <ResultsRailBody projectId={projectId} model={results} onOpenResult={setOpenResult} />
        </Section>
      </div>
      {openResult && projectId ? (
        <ResultViewerOverlay
          projectId={projectId}
          result={openResult}
          onClose={() => setOpenResult(null)}
        />
      ) : null}
    </aside>
  );
}
