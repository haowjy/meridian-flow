import { Button } from '@/shared/components/ui/button'
import { DialogFooter } from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Field } from '@/shared/components/Field'
import { validateFiles, formatFileSize } from '../utils/fileValidation'
import { useState } from 'react'

interface ImportFileSelectorProps {
  selectedFiles: File[]
  onFileSelect: (files: File[]) => void
  onSubmit: () => void
  onCancel: () => void
  error: string | null
}

export function ImportFileSelector({
  selectedFiles,
  onFileSelect,
  onSubmit,
  onCancel,
  error,
}: ImportFileSelectorProps) {
  const [validationErrors, setValidationErrors] = useState<
    Array<{ file: string; error: string }>
  >([])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])

    // Validate files
    const errors = validateFiles(files)
    setValidationErrors(errors)

    // Only pass valid files to parent if no errors
    if (errors.length === 0) {
      onFileSelect(files)
    } else {
      onFileSelect([])
    }
  }

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0)

  return (
    <>
      <div className="grid gap-4 py-4">
        <Field label="Import Files" id="importFiles" required>
          <Input
            id="importFiles"
            type="file"
            accept=".zip,.md,.txt,.html"
            onChange={handleFileChange}
            multiple
          />
          {selectedFiles.length > 0 && (
            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <p className="font-medium">
                {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected (
                {formatFileSize(totalSize)} total)
              </p>
              <ul className="list-disc list-inside max-h-32 overflow-y-auto">
                {selectedFiles.map((file, index) => (
                  <li key={index}>
                    {file.name} ({formatFileSize(file.size)})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Field>

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
