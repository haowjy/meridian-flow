import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { api, ImportResponse } from '@/core/lib/api'
import { ImportFileSelector } from './ImportFileSelector'
import { ImportProgress } from './ImportProgress'
import { ImportResults } from './ImportResults'

type DialogPhase = 'selection' | 'uploading' | 'results'

interface ImportDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  folderId: string | null // null = root level
  onComplete: () => void // Callback to refresh tree
  initialFiles?: File[] // Pre-selected files (e.g., from drag-and-drop)
}

export function ImportDocumentDialog({
  open,
  onOpenChange,
  projectId,
  folderId,
  onComplete,
  initialFiles,
}: ImportDocumentDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>('selection')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [results, setResults] = useState<ImportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [prevInitialFiles, setPrevInitialFiles] = useState(initialFiles)

  // Sync initial files when prop changes.
  // This uses React's "adjust state during render" pattern (recommended over useEffect).
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  //
  // Why: initialFiles prop comes from drag-and-drop which can trigger mid-render.
  // Using useEffect would cause an extra render cycle; this pattern is synchronous.
  if (initialFiles !== prevInitialFiles) {
    setPrevInitialFiles(initialFiles)
    if (open && initialFiles && initialFiles.length > 0) {
      setSelectedFiles(initialFiles)
    }
  }

  const handleFileSelect = (files: File[]) => {
    setSelectedFiles(files)
    // Clear previous error when selecting new files
    if (error) setError(null)
  }

  const handleSubmit = async () => {
    if (selectedFiles.length === 0) return

    setPhase('uploading')
    setError(null)

    try {
      const data = await api.documents.import(projectId, selectedFiles, folderId, { overwrite })
      setResults(data)
      setPhase('results')
      onComplete() // Refresh tree after successful import
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to import documents'
      setError(errorMessage)
      setPhase('selection')
    }
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const handleImportMore = () => {
    setPhase('selection')
    setSelectedFiles([])
    setResults(null)
    setError(null)
    setOverwrite(false)
  }

  const handleOpenChange = (newOpen: boolean) => {
    // Prevent closing during upload
    if (phase === 'uploading') return

    onOpenChange(newOpen)

    // Reset state when dialog closes
    if (!newOpen) {
      setPhase('selection')
      setSelectedFiles([])
      setResults(null)
      setError(null)
      setOverwrite(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-3 p-5">
        <DialogHeader>
          <DialogTitle>Import Documents</DialogTitle>
          <DialogDescription>
            Import documents from zip files, markdown, text, or HTML files into{' '}
            {folderId ? 'this folder' : 'project root'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'selection' && (
          <ImportFileSelector
            selectedFiles={selectedFiles}
            onFileSelect={handleFileSelect}
            onSubmit={handleSubmit}
            onCancel={handleClose}
            error={error}
            overwrite={overwrite}
            onOverwriteChange={setOverwrite}
          />
        )}

        {phase === 'uploading' && <ImportProgress />}

        {phase === 'results' && results && (
          <ImportResults
            results={results}
            onClose={handleClose}
            onImportMore={handleImportMore}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
