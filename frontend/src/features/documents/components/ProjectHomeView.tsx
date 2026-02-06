import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useRecentDocumentsStore } from "@/core/stores/useRecentDocumentsStore";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { openDocument } from "@/core/lib/panelHelpers";
import type { Document } from "../types/document";

// Stable empty array to prevent infinite re-renders from `?? []` in selectors
const EMPTY: never[] = [];

interface ProjectHomeViewProps {
  projectId: string;
  projectSlug: string;
}

/**
 * Project home screen shown when no document is selected.
 * Extensible - content sections can be added/swapped easily.
 */
export function ProjectHomeView({
  projectId,
  projectSlug,
}: ProjectHomeViewProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      {/* Content sections - easy to add/swap */}
      <RecentDocumentsSection projectId={projectId} projectSlug={projectSlug} />
      {/* Future: <PinnedDocumentsSection />, <ProjectStatsSection />, etc. */}
    </div>
  );
}

/**
 * Get folder path from document's path property.
 * Returns the directory portion (everything before the filename).
 * Example: "Characters/Heroes/Aria.md" → "Characters/Heroes"
 */
function getFolderPath(doc: Document): string | null {
  if (!doc.path) return null;
  const lastSlash = doc.path.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return doc.path.slice(0, lastSlash);
}

function RecentDocumentsSection({
  projectId,
  projectSlug,
}: ProjectHomeViewProps) {
  const navigate = useNavigate();
  const recentDocs = useRecentDocumentsStore(
    (s) => s.recentByProject[projectId] ?? EMPTY,
  );
  const documents = useTreeStore((s) => s.documents);

  // Resolve recent document IDs to full document objects
  // Filters out any that no longer exist (deleted) and limits to 10
  const resolvedDocs = useMemo(() => {
    return recentDocs
      .map((r) => documents.find((d) => d.id === r.documentId))
      .filter((d): d is Document => d !== undefined)
      .slice(0, 10);
  }, [recentDocs, documents]);

  if (resolvedDocs.length === 0) {
    return (
      <div className="text-muted-foreground px-4 py-8 text-center text-sm">
        No recent documents
      </div>
    );
  }

  return (
    <div className="px-3 py-3">
      <h3 className="text-muted-foreground mb-2 px-1.5 text-xs font-medium tracking-wide uppercase">
        Recently Viewed
      </h3>
      <div className="space-y-0.5">
        {resolvedDocs.map((doc) => {
          const folderPath = getFolderPath(doc);
          return (
            <button
              key={doc.id}
              type="button"
              onClick={() =>
                openDocument(doc.id, doc.path, projectSlug, navigate)
              }
              className="group hover:bg-hover flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm transition-colors"
            >
              <FileText className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{doc.name}</div>
                {folderPath && (
                  <div className="text-muted-foreground truncate text-xs">
                    {folderPath}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
