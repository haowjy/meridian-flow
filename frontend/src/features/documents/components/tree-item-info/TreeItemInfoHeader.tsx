import { FileText, Folder } from 'lucide-react'

interface TreeItemInfoHeaderProps {
  name: string
  type: 'folder' | 'document'
}

/**
 * Header section for tree item info.
 * Shows the full name (no truncation) with appropriate icon.
 */
export function TreeItemInfoHeader({ name, type }: TreeItemInfoHeaderProps) {
  const Icon = type === 'folder' ? Folder : FileText

  return (
    <div className="flex items-start gap-2">
      <Icon className="size-3.5 flex-shrink-0 mt-0.5 text-muted-foreground" />
      <span className="font-medium text-sm break-words">{name}</span>
    </div>
  )
}
