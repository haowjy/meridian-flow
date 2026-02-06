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

  // Trailing: document status
  const trailingContent = status && (
    <DocumentStatus
      wordCount={wordCount ?? 0}
      status={status}
      lastSaved={lastSaved ?? null}
    />
  );

  return (
    <PanelHeader
      leading={leadingContent}
      trailing={trailingContent}
      showGradient={true}
      showBorder={true}
      ariaLabel={`Breadcrumb: ${fullPathTitle}`}
    />
  );
}
