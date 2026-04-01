import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react"

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view"

import { createComposerKeymap } from "./composer-keymap"
import { composerTheme } from "./composer-theme"

const noop = () => {}

export interface ComposerEditorRef {
  extractText: () => string
  isEmpty: () => boolean
  focus: () => void
  clear: () => void
  setContent: (text: string) => void
}

export interface ComposerEditorProps {
  placeholder?: string
  focusKey?: string | null
  onSubmit: () => void
  onEscape?: () => void
  onArrowUpEmpty?: () => void
  onContentChange?: () => void
  extraExtensions?: Extension[]
}

export const ComposerEditor = forwardRef<ComposerEditorRef, ComposerEditorProps>(
  function ComposerEditor(
    {
      placeholder,
      focusKey,
      onSubmit,
      onEscape,
      onArrowUpEmpty,
      onContentChange,
      extraExtensions,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const placeholderCompartmentRef = useRef(new Compartment())
    const extraExtensionsRef = useRef(extraExtensions)

    const onSubmitRef = useRef(onSubmit)
    const onEscapeRef = useRef(onEscape ?? noop)
    const onArrowUpEmptyRef = useRef(onArrowUpEmpty ?? noop)
    const onContentChangeRef = useRef(onContentChange)

    onSubmitRef.current = onSubmit
    onEscapeRef.current = onEscape ?? noop
    onArrowUpEmptyRef.current = onArrowUpEmpty ?? noop
    onContentChangeRef.current = onContentChange

    useImperativeHandle(
      ref,
      () => ({
        extractText: () => viewRef.current?.state.doc.toString() ?? "",
        isEmpty: () => {
          const text = viewRef.current?.state.doc.toString() ?? ""
          return text.trim().length === 0
        },
        focus: () => {
          viewRef.current?.focus()
        },
        clear: () => {
          const view = viewRef.current
          if (!view) {
            return
          }

          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: "",
            },
          })
        },
        setContent: (text: string) => {
          const view = viewRef.current
          if (!view) {
            return
          }

          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: text,
            },
            selection: {
              anchor: text.length,
            },
          })
        },
      }),
      [],
    )

    useEffect(() => {
      const container = containerRef.current
      if (!container) {
        return
      }

      const state = EditorState.create({
        doc: "",
        extensions: [
          drawSelection(),
          history(),
          keymap.of(historyKeymap),
          Prec.highest(
            keymap.of(
              createComposerKeymap({
                onSubmit: () => onSubmitRef.current(),
                onEscape: () => onEscapeRef.current(),
                onArrowUpEmpty: () => onArrowUpEmptyRef.current(),
                isPopoverOpen: () => false,
              }),
            ),
          ),
          keymap.of(defaultKeymap),
          composerTheme,
          ...(extraExtensionsRef.current ?? []),
          EditorView.lineWrapping,
          placeholderCompartmentRef.current.of(
            placeholderExtension(placeholder ?? "Write a reply..."),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onContentChangeRef.current?.()
            }
          }),
        ],
      })

      const view = new EditorView({
        parent: container,
        state,
      })

      viewRef.current = view

      return () => {
        view.destroy()
        viewRef.current = null
      }
      // initialize once, callbacks/extensions are read through refs
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
      const view = viewRef.current
      if (!view) {
        return
      }

      view.dispatch({
        effects: placeholderCompartmentRef.current.reconfigure(
          placeholderExtension(placeholder ?? "Write a reply..."),
        ),
      })
    }, [placeholder])

    useEffect(() => {
      if (!focusKey) {
        return
      }

      requestAnimationFrame(() => {
        const view = viewRef.current
        if (!view) {
          return
        }

        view.focus()
        view.dispatch({
          selection: {
            anchor: view.state.doc.length,
          },
        })
      })
    }, [focusKey])

    return <div ref={containerRef} className="composer-editor" />
  },
)
