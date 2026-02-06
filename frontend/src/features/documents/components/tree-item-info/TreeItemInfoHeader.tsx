import { FileText, Folder } from "lucide-react";

interface TreeItemInfoHeaderProps {
  name: string;
  type: "folder" | "document";
}

/**
 * Header section for tree item info.
 * Shows the full name (no truncation) with appropriate icon.
 */
export function TreeItemInfoHeader({ name, type }: TreeItemInfoHeaderProps) {
  const Icon = type === "folder" ? Folder : FileText;

  return (
    <div className="flex items-start gap-2">
      <Icon className="text-muted-foreground mt-0.5 size-3.5 flex-shrink-0" />
      <span className="text-sm font-medium break-words">{name}</span>
    </div>
  );
}
