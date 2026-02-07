/**
 * Composer Keymap
 *
 * Custom keybindings for the thread composer:
 * - Enter: submit (when mention popover is not active)
 * - Escape: clear editor / clear interjection / stop streaming
 * - ArrowUp: load interjection for editing (when doc is empty)
 */

import { type KeyBinding } from "@codemirror/view";

export interface ComposerKeymapOptions {
  /** Called when Enter is pressed (no shift) */
  onSubmit: () => void;
  /** Called when Escape is pressed with prioritized behavior */
  onEscape: () => void;
  /** Called when ArrowUp is pressed in an empty editor */
  onArrowUpEmpty: () => void;
  /** Returns true when mention popover is open; Enter should be handled by popover */
  isPopoverOpen?: () => boolean;
}

/**
 * Create composer keymap bindings.
 * Must be wrapped in Prec.highest to override defaults.
 */
export function createComposerKeymap(
  options: ComposerKeymapOptions,
): KeyBinding[] {
  return [
    {
      key: "Enter",
      run: () => {
        if (options.isPopoverOpen?.()) return false;
        options.onSubmit();
        return true;
      },
    },
    {
      key: "Escape",
      run: () => {
        options.onEscape();
        return true;
      },
    },
    {
      key: "ArrowUp",
      run: (view) => {
        // Only intercept when the editor is empty
        if (view.state.doc.length === 0) {
          options.onArrowUpEmpty();
          return true;
        }
        return false;
      },
    },
  ];
}
