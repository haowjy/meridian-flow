import {
  BookOpen,
  Code,
  Export,
  FileDoc,
  FilePdf,
  FileText,
  TextAa,
} from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import {
  exportDOCX,
  exportEPUB,
  exportHTML,
  exportMarkdown,
  exportPDF,
  exportPlainText,
} from "./exporters"

export interface ExportDropdownProps {
  /** Document name for the exported file */
  documentName: string
  /** Callback to get the document content. If not provided, export buttons are disabled. */
  getContent?: () => string
  /** Document ID for server-side exports (PDF, DOCX, EPUB) */
  documentId?: string
  className?: string
}

/**
 * Export dropdown in the title header.
 *
 * Client-side exports (Markdown, Plain Text, HTML) use getContent()
 * and download via blob URLs. Server-side exports (PDF, DOCX, EPUB)
 * are stubs with a "Server" badge indicating backend dependency.
 */
export function ExportDropdown({
  documentName,
  getContent,
  documentId,
  className,
}: ExportDropdownProps) {
  const handleExport = (
    exportFn: (content: string, name: string) => void,
  ) => {
    if (!getContent) return
    const content = getContent()
    exportFn(content, documentName)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
        >
          <Export size={14} />
          Export
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onSelect={() => handleExport(exportMarkdown)}
          disabled={!getContent}
        >
          <FileText size={14} className="mr-2 shrink-0" />
          Markdown (.md)
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => handleExport(exportPlainText)}
          disabled={!getContent}
        >
          <TextAa size={14} className="mr-2 shrink-0" />
          Plain Text (.txt)
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => handleExport(exportHTML)}
          disabled={!getContent}
        >
          <Code size={14} className="mr-2 shrink-0" />
          HTML (.html)
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => exportPDF(documentId ?? "", documentName)}
          disabled
        >
          <FilePdf size={14} className="mr-2 shrink-0" />
          PDF (.pdf)
          <Badge variant="outline" className="ml-auto text-xs px-1.5 py-0">
            Server
          </Badge>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => exportDOCX(documentId ?? "", documentName)}
          disabled
        >
          <FileDoc size={14} className="mr-2 shrink-0" />
          Word (.docx)
          <Badge variant="outline" className="ml-auto text-xs px-1.5 py-0">
            Server
          </Badge>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => exportEPUB(documentId ?? "", documentName)}
          disabled
        >
          <BookOpen size={14} className="mr-2 shrink-0" />
          EPUB (.epub)
          <Badge variant="outline" className="ml-auto text-xs px-1.5 py-0">
            Server
          </Badge>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
