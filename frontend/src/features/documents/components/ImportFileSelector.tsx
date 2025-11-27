import { useState, useRef, DragEvent } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { DialogFooter } from '@/shared/components/ui/dialog'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Label } from '@/shared/components/ui/label'
import { validateFiles, formatFileSize } from '../utils/fileValidation'
import { cn } from '@/lib/utils'

interface ImportFileSelectorProps {
  selectedFiles: File[]
  onFileSelect: (files: File[]) => void
  onSubmit: () => void
  onCancel: () => void
  error: string | null
  overwrite: boolean
  onOverwriteChange: (overwrite: boolean) => void
}

export function ImportFileSelector({
  selectedFiles,
  onFileSelect,
  onSubmit,
  onCancel,
  error,
  overwrite,
  onOverwriteChange,
}: ImportFileSelectorProps) {
  const [validationErrors, setValidationErrors] = useState<
    Array<{ file: string; error: string }>
  >([])
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (files: File[]) => {
    const errors = validateFiles(files)
    setValidationErrors(errors)

    if (errors.length === 0) {
      onFileSelect(files)
    } else {
      onFileSelect([])
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    handleFiles(files)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    handleFiles(files)
  }

  const handleChooseFiles = () => {
    inputRef.current?.click()
  }

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0)

  return (
    <>
      <div className="space-y-3">
        {/* Dropzone */}
        <div
          onClick={handleChooseFiles}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-1 p-4 rounded-lg cursor-pointer transition-colors',
            'border-2 border-dashed',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 bg-muted/30 hover:border-muted-foreground/50 hover:bg-muted/50'
          )}
        >
          <div className="rounded-full bg-muted p-2">
            <Upload className="size-5 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              Click or drag files to import
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.md,.txt,.html"
            onChange={handleFileChange}
            multiple
            className="hidden"
          />
        </div>

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div className="text-sm space-y-2">
            <p className="font-medium text-muted-foreground">
              {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected ({formatFileSize(totalSize)} total)
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
              {selectedFiles.map((file, index) => (
                <li key={index} className="flex items-center gap-2">
                  <span className="truncate">{file.name}</span>
                  <span className="text-muted-foreground/60">({formatFileSize(file.size)})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Overwrite checkbox */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="overwrite"
            checked={overwrite}
            onCheckedChange={(checked) => onOverwriteChange(checked === true)}
          />
          <Label htmlFor="overwrite" className="text-sm font-normal cursor-pointer">
            Overwrite existing documents
          </Label>
        </div>

        {/* Validation errors */}
        {validationErrors.length > 0 && (
          <div className="rounded bg-destructive/10 border border-destructive/20 px-3 py-2">
            <p className="text-sm text-destructive font-medium mb-2" role="alert">
              Validation Errors:
            </p>
            <ul className="text-xs text-destructive space-y-1">
              {validationErrors.map((err, index) => (
                <li key={index}>
                  <strong>{err.file}:</strong> {err.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* API error */}
        {error && (
          <div className="rounded bg-destructive/10 border border-destructive/20 px-3 py-2">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={selectedFiles.length === 0}>
          Import
        </Button>
      </DialogFooter>
    </>
  )
}
