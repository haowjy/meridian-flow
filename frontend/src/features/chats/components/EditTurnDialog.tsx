import React, { useState, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'

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

    // Reset content when dialog opens/initialContent changes
    useEffect(() => {
        if (isOpen) {
            setContent(initialContent)
        }
    }, [isOpen, initialContent])

    const handleSave = async () => {
        if (!content.trim()) return

        setIsSaving(true)
        try {
            await onSave(content)
            onClose()
        } catch (error) {
            console.error('Failed to save turn:', error)
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[600px]">
                <DialogHeader>
                    <DialogTitle>Edit Message</DialogTitle>
                </DialogHeader>
                <div className="py-4">
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        className="w-full min-h-[150px] p-3 rounded-md border border-input bg-transparent text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                        placeholder="Type your message here..."
                        autoFocus
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={isSaving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={isSaving || !content.trim()}>
                        {isSaving ? 'Saving...' : 'Save & Branch'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
