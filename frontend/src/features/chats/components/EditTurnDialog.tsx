import React, { useState, useEffect, useMemo } from 'react'
import { Button } from '@/shared/components/ui/button'
import { AutosizeTextarea } from '@/features/chats/components/AutosizeTextarea'
import { ChatRequestControls } from '@/features/chats/components/ChatRequestControls'
import type { ChatRequestOptions, RequestParams } from '@/features/chats/types'
import { requestParamsToOptions } from '@/features/chats/types'

interface EditTurnDialogProps {
  isOpen: boolean
  onClose: () => void
  initialContent: string
  /** Original request params from the turn being edited */
  originalRequestParams?: RequestParams | null
  onSave: (content: string, options: ChatRequestOptions) => Promise<void>
}

export function EditTurnDialog({
  isOpen,
  onClose,
  initialContent,
  originalRequestParams,
  onSave,
}: EditTurnDialogProps) {
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)

  // Initialize options from original request params
  const initialOptions = useMemo(
    () => requestParamsToOptions(originalRequestParams),
    [originalRequestParams]
  )
  const [options, setOptions] = useState<ChatRequestOptions>(initialOptions)

  // Reset content and options when dialog opens
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent)
      setOptions(requestParamsToOptions(originalRequestParams))
    }
  }, [isOpen, initialContent, originalRequestParams])



  const handleSave = async () => {
    // Validate content before saving
    if (!content.trim()) return

    setIsSaving(true)
    try {
      await onSave(content, options)
      onClose()
    } catch (error) {
      console.error('Failed to save turn:', error)
    } finally {
      setIsSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="flex flex-col w-full rounded-xl bg-card px-3 py-2 shadow-md">
      <AutosizeTextarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Edit your message..."
        autoFocus
        maxHeight="50vh"
        minHeight="auto"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!isSaving) onClose()
          }
        }}
      />
      <ChatRequestControls
        options={options}
        onOptionsChange={setOptions}
        rightContent={
          <>
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
              className="px-3 py-1 text-xs sm:text-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !content.trim()}
              className="px-3 py-1 text-xs sm:text-sm"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      />
    </div>
  )
}
