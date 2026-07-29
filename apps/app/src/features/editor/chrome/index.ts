/**
 * Editor chrome primitives — what every surface lane builds from.
 *
 * Anchoring, dismissal, focus return, and the object row live here once. A
 * lane that re-implements one of them will drift from the rest of the toolkit
 * on the first Radix upgrade.
 */

export {
  type ChromeLayerBinding,
  type UseChromeLayerOptions,
  useChromeLayer,
} from "./chrome-layers";
// Types only, deliberately. The surface list names every lane and the host
// renders it, so a barrel carrying either would make importing one primitive
// import every surface in the editor — a lane's tests then load every other
// lane's dependencies. `EditorView` imports the host from its own module; a lane
// never imports it at all.
export type { EditorChromeSurface, EditorChromeSurfaceProps } from "./chrome-surfaces";
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
export {
  type ObjectOverlayCorner,
  type ObjectOverlayPlacement,
  useObjectOverlayCorner,
} from "./object-overlay";
export {
  SuggestionMenu,
  type SuggestionMenuProps,
  type SuggestionMenuRow,
} from "./SuggestionMenu";
export { shortcutLabel } from "./shortcut-label";
export { type AnchorRect, useAnchorRect } from "./useAnchorRect";
export {
  useChromeCoarsePointer,
  useChromeContext,
  useChromeSuppressed,
  useEditorChrome,
  useEditorRevision,
} from "./useEditorChrome";
export { useFadeHold } from "./useFadeHold";
export { type TakeNodeHold, useNodeHold } from "./useNodeHold";
