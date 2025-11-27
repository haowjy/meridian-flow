import React, { useState, useEffect, useRef } from 'react'
import { Button } from '@/shared/components/ui/button'
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
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

  useEffect(() => {
    if (!isOpen || !textareaRef.current) return

    const el = textareaRef.current
    const length = el.value.length
    // Place cursor at the end of the content for quicker edits
    el.focus()
    try {
      el.setSelectionRange(length, length)
    } catch {
      // Some browsers may not support setSelectionRange on certain input types.
    }
  }, [isOpen])

  const handleSave = async () => {
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
    <div className="w-full rounded-xl bg-card px-3 py-2 shadow-md">
      <div className="py-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="w-full min-h-[6rem] resize-y rounded-md bg-transparent p-2 text-sm outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus:ring-offset-0 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Edit your message..."
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              if (!isSaving) onClose()
            }
          }}
        />
      </div>
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
