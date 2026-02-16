import type { ReactNode } from "react";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { buildBreadcrumbs } from "@/core/lib/breadcrumbBuilder";
import type { Document } from "@/features/documents/types/document";
import { PanelHeader } from "@/shared/components/layout/headers";
import { DocumentStatus } from "./DocumentStatus";
import { useProjectStore } from "@/core/stores/useProjectStore";
import {
  CompactBreadcrumb,
  type BreadcrumbSegment,
} from "@/shared/components/ui/CompactBreadcrumb";
import type { SaveStatus } from "@/shared/components/ui/StatusBadge";
import { useUIStore } from "@/core/stores/useUIStore";
import { DocumentTreeToggle } from "@/shared/components/layout";
import { Button } from "@/shared/components/ui/button";
import { History } from "lucide-react";
import { cn } from "@/lib/utils";

interface EditorHeaderProps {
  document: Document;
  wordCount?: number;
  status?: SaveStatus;
  lastSaved?: Date | null;
  // Mobile navigation: back button (shown before breadcrumb on mobile)
  mobileBackButton?: ReactNode;
}

/**
 * Compact editor header with breadcrumb and view toggle.
 * Layout: [Project / ... / Last Folder / File] | [Read/Edit Toggle]
 * Consistent style with explorer; no muted background in read-only.
 */
export function EditorHeader({
  document,
  wordCount,
  status,
  lastSaved,
  mobileBackButton,
}: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders);
  const projectName = useProjectStore(
    (s) =>
      s.projects.find((p) => p.id === document.projectId)?.name ||
      s.currentProject()?.name ||
      "Project",
  );
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed);
  const showVersionHistory = useUIStore((s) => s.showVersionHistory);
  const toggleVersionHistory = useUIStore((s) => s.toggleVersionHistory);

  // Build full folder path; we'll display as: Project / ... / Last Folder / File.ext
  const fullFolderPath = buildBreadcrumbs(document.folderId, folders, 99);
  const fullPathTitle = [
    projectName,
    ...fullFolderPath.map((s) => s.name),
    document.filename,
  ].join(" / ");

  // User requested to show only the document filename to save space.
  // We still build the full path for the tooltip.
  const segments: BreadcrumbSegment[] = [{ label: document.filename }];

  // Leading: mobile back button + document tree toggle (when collapsed)
  const leadingContent = (
    <>
      {mobileBackButton && <div className="md:hidden">{mobileBackButton}</div>}
      {documentTreeCollapsed && (
        <div className="hidden md:block">
          <DocumentTreeToggle />
        </div>
      )}
      <div title={fullPathTitle}>
        <CompactBreadcrumb segments={segments} />
      </div>
    </>
  );

  // Trailing: version history toggle + document status
  const trailingContent = (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-6 w-6",
          showVersionHistory && "bg-muted text-primary",
        )}
        onClick={toggleVersionHistory}
        title="Version history"
      >
        <History className="h-3.5 w-3.5" />
      </Button>
      {status && (
        <DocumentStatus
          wordCount={wordCount ?? 0}
          status={status}
          lastSaved={lastSaved ?? null}
        />
      )}
    </div>
  );

  return (
    <PanelHeader
      leading={leadingContent}
      trailing={trailingContent}
      showGradient={true}
      showBorder={false}
      ariaLabel={`Breadcrumb: ${fullPathTitle}`}
    />
  );
}
