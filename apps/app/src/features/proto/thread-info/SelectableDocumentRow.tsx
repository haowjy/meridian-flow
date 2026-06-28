/**
 * Proto-only selectable document row — mirrors DocumentRow visuals with active state.
 */
import type { DocumentFileType } from "@meridian/contracts/protocol";
import { FileText, Image as ImageIcon } from "lucide-react";

import type { RailDocument } from "@/features/chat/ThreadDocumentList";
import { cn } from "@/lib/utils";

export function SelectableDocumentRow({
  document,
  active,
  onSelect,
}: {
  document: RailDocument;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "focus-ring flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-left transition-colors",
          active ? "border-primary bg-primary/10" : "border-transparent hover:bg-sidebar-accent",
        )}
        title={document.name}
        aria-pressed={active}
      >
        <KindIcon fileType={document.fileType} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{document.name}</span>
          <span className="truncate text-meta text-muted-foreground">
            {formatFileDetail(document.extension, document.sizeBytes)}
          </span>
        </span>
      </button>
    </li>
  );
}

function KindIcon({ fileType }: { fileType: DocumentFileType | null }) {
  const { Icon, tone } = pickIcon(fileType);
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-surface-subtle",
        tone,
      )}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function pickIcon(fileType: DocumentFileType | null): { Icon: typeof FileText; tone: string } {
  switch (fileType) {
    case null:
      return { Icon: FileText, tone: "text-primary" };
    case "image":
      return { Icon: ImageIcon, tone: "text-status-streaming" };
    case "pdf":
      return { Icon: FileText, tone: "text-destructive" };
    case "docx":
      return { Icon: FileText, tone: "text-accent" };
    case "binary":
      return { Icon: FileText, tone: "text-muted-foreground" };
  }
}

function formatFileDetail(extension: string, sizeBytes: number | null): string {
  const ext = extension.replace(/^\./, "").toUpperCase();
  if (sizeBytes == null) return ext || "";
  const size = formatBytes(sizeBytes);
  return ext ? `${ext} · ${size}` : size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
