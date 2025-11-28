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
import { ImportPreview } from './ImportPreview'
import { ImportProgress } from './ImportProgress'
import { ImportResults } from './ImportResults'
import { processSelection, buildUploadFiles, getValidFileCount } from '../utils/importProcessing'
import type { ImportSelection } from '../types/import'

type DialogPhase = 'selection' | 'preview' | 'uploading' | 'results'

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
  const [selection, setSelection] = useState<ImportSelection | null>(null)
  const [results, setResults] = useState<ImportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
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
      // Process initial files and go to preview
      const processed = processSelection(initialFiles as unknown as FileList)
      if (getValidFileCount(processed) > 0) {
        setSelection(processed)
        setPhase('preview')
      }
    }
  }

  const handleFilesSelected = (files: FileList) => {
    // Clear previous error when selecting new files
    if (error) setError(null)

    // Process files into categorized selection
    const processed = processSelection(files)

    // If we have valid files, go to preview; otherwise show error
    if (getValidFileCount(processed) > 0) {
      setSelection(processed)
      setPhase('preview')
    } else if (processed.skippedFiles.length > 0) {
      setError('No supported files found. Supported formats: .md, .txt, .html, .zip')
    }
  }

  const handleConfirmImport = async () => {
    if (!selection || getValidFileCount(selection) === 0) return

    setIsProcessing(true)
    setError(null)

    try {
      // Build final upload files (zips folders if needed)
      const uploadFiles = await buildUploadFiles(selection)

      setIsProcessing(false)
      setPhase('uploading')

      // Upload to API
      const data = await api.documents.import(projectId, uploadFiles, folderId, { overwrite })
      setResults(data)
      setPhase('results')
      onComplete() // Refresh tree after successful import
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to import documents'
      setError(errorMessage)
      setIsProcessing(false)
      setPhase('preview') // Stay on preview to show error
    }
  }

  const handleBackToSelection = () => {
    setPhase('selection')
    setSelection(null)
    setError(null)
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const handleImportMore = () => {
    setPhase('selection')
    setSelection(null)
    setResults(null)
    setError(null)
    setOverwrite(false)
  }

  const handleOpenChange = (newOpen: boolean) => {
    // Prevent closing during upload or processing
    if (phase === 'uploading' || isProcessing) return

    onOpenChange(newOpen)

    // Reset state when dialog closes
    if (!newOpen) {
      setPhase('selection')
      setSelection(null)
      setResults(null)
      setError(null)
      setOverwrite(false)
      setIsProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-3 p-5 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Documents</DialogTitle>
          <DialogDescription>
            Import documents from zip files, markdown, text, or HTML files into{' '}
            {folderId ? 'this folder' : 'project root'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'selection' && (
          <ImportFileSelector
            onFilesSelected={handleFilesSelected}
            onCancel={handleClose}
            error={error}
          />
        )}

        {phase === 'preview' && selection && (
          <ImportPreview
            selection={selection}
            onConfirm={handleConfirmImport}
            onCancel={handleBackToSelection}
            overwrite={overwrite}
            onOverwriteChange={setOverwrite}
            isProcessing={isProcessing}
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
