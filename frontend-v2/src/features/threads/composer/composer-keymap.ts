import type { KeyBinding } from "@codemirror/view"

export interface ComposerKeymapOptions {
  onSubmit: () => void
  onEscape: () => void
  onArrowUpEmpty: () => void
  isPopoverOpen?: () => boolean
}

export function createComposerKeymap(
  options: ComposerKeymapOptions,
): KeyBinding[] {
  return [
    {
      key: "Enter",
      run: () => {
        if (options.isPopoverOpen?.()) {
          return false
        }

        options.onSubmit()
        return true
      },
    },
    {
      key: "Escape",
      run: () => {
        options.onEscape()
        return true
      },
    },
    {
      key: "ArrowUp",
      run: (view) => {
        if (view.state.doc.length > 0) {
          return false
        }

        options.onArrowUpEmpty()
        return true
      },
    },
  ]
}
