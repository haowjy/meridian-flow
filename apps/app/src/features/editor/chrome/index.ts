/**
 * Editor chrome primitives — what every surface lane builds from.
 *
 * Anchoring, dismissal, focus return, and the object row live here once. A
 * lane that re-implements one of them will drift from the rest of the toolkit
 * on the first Radix upgrade.
 */

export {
  EDITOR_CHROME_SURFACES,
  type EditorChromeSurface,
  type EditorChromeSurfaceProps,
} from "./chrome-surfaces";
export { EditorChromeHost } from "./EditorChromeHost";
export { EditorDialog, type EditorDialogProps } from "./EditorDialog";
export {
  EditorMenu,
  EditorMenuCheckboxItem,
  EditorMenuGroup,
  EditorMenuItem,
  EditorMenuLabel,
  type EditorMenuProps,
  EditorMenuRadioGroup,
  EditorMenuRadioItem,
  EditorMenuSeparator,
  EditorMenuShortcut,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
} from "./EditorMenu";
export { EditorPopover, type EditorPopoverProps } from "./EditorPopover";
export {
  OverlayIconRow,
  type OverlayIconRowItem,
  type OverlayIconRowProps,
} from "./OverlayIconRow";
export { type AnchorRect, useAnchorRect } from "./useAnchorRect";
export {
  useChromeContext,
  useChromeLayer,
  useChromeSuppressed,
  useEditorChrome,
  useEditorRevision,
  useReturnFocusToProse,
} from "./useEditorChrome";
