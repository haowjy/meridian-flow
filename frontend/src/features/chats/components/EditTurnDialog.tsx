import React, { useState, useEffect } from 'react'
import { Button } from '@/shared/components/ui/button'
import { AutosizeTextarea } from '@/features/chats/components/AutosizeTextarea'
import { ChatRequestControls } from '@/features/chats/components/ChatRequestControls'
import type { ChatRequestOptions } from '@/features/chats/types'

interface EditTurnDialogProps {
  isOpen: boolean
  onClose: () => void
  initialContent: string
  onSave: (content: string) => Promise<void>
}

export function EditTurnDialog({
  isOpen,
  onClose,
  initialContent,
  onSave,
}: EditTurnDialogProps) {
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)
  const [options, setOptions] = useState<ChatRequestOptions>({
    modelId: 'moonshotai/kimi-k2-thinking',
    modelLabel: 'Kimi K2 Thinking',
    providerId: 'openrouter',
    reasoning: 'low',
  })

  // Reset content when dialog opens/initialContent changes
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent)
    }
  }, [isOpen, initialContent])



  const handleSave = async () => {
    // Validate content before saving
    if (!content.trim()) return

    setIsSaving(true)
    try {
      // TODO: extend onSave to accept ChatRequestOptions and forward them to editTurn request_params.
      await onSave(content)
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
