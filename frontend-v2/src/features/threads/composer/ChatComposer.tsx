import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

import { ComposerControls } from "./ComposerControls"
import { ComposerEditor, type ComposerEditorRef } from "./ComposerEditor"
import { composerInputMinHeight } from "./composer-theme"

const noop = () => {}

const composerExtensions = [composerInputMinHeight]

export interface ChatComposerRef {
  focus: () => void
  clear: () => void
  isEmpty: () => boolean
}

/** Context passed to the controls render prop so custom controls can wire up send/stop. */
export interface ComposerControlsContext {
  hasContent: boolean
  isStreaming: boolean
  onSend: () => void
  onStop?: () => void
}

export interface ChatComposerProps {
  onSubmit: (text: string) => void
  placeholder?: string
  isStreaming?: boolean
  onStop?: () => void
  className?: string
  /** Replace the default controls bar. Rendered below the editor. */
  controls?: ReactNode
}

export const ChatComposer = forwardRef<ChatComposerRef, ChatComposerProps>(
  function ChatComposer(
    {
      onSubmit,
      placeholder = "Write a reply...",
      isStreaming = false,
      onStop,
      className,
      controls,
    },
    ref,
  ) {
    const editorRef = useRef<ComposerEditorRef>(null)
    const [hasContent, setHasContent] = useState(false)

    const handleContentChange = useCallback(() => {
      setHasContent(!(editorRef.current?.isEmpty() ?? true))
    }, [])

    const handleSubmit = useCallback(() => {
      if (isStreaming) {
        return
      }

      const text = editorRef.current?.extractText().trim() ?? ""
      if (text.length === 0) {
        return
      }

      onSubmit(text)
      editorRef.current?.clear()
      setHasContent(false)
    }, [isStreaming, onSubmit])

    const handleEscape = useCallback(() => {
      if (!isStreaming) {
        return
      }

      onStop?.()
    }, [isStreaming, onStop])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          editorRef.current?.focus()
        },
        clear: () => {
          editorRef.current?.clear()
          setHasContent(false)
        },
        isEmpty: () => editorRef.current?.isEmpty() ?? true,
      }),
      [],
    )

    return (
      <div
        className={cn(
          "rounded-lg border border-border/60 bg-card shadow-sm transition-shadow focus-within:border-border focus-within:shadow-md",
          className,
        )}
      >
        <div className="px-2.5 py-1.5">
          <ComposerEditor
            ref={editorRef}
            placeholder={placeholder}
            onSubmit={handleSubmit}
            onEscape={handleEscape}
            onArrowUpEmpty={noop}
            onContentChange={handleContentChange}
            extraExtensions={composerExtensions}
          />
          {controls ?? (
            <ComposerControls
              className="pt-0.5"
              hasContent={hasContent}
              isStreaming={isStreaming}
              onSend={handleSubmit}
              onStop={onStop}
            />
          )}
        </div>
      </div>
    )
  },
)
