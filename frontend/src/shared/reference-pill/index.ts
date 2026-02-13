// Public API for the shared reference-pill module
export { createPillElement, type PillOptions } from "./createPillElement";
export { ReferencePill, type ReferencePillProps } from "./ReferencePill";
export { FolderContentPopover } from "./FolderContentPopover";
export { usePillNavigation } from "./usePillNavigation";
export {
  resolvePillBehavior,
  pillBehaviorToDataAttributes,
  type PillBehavior,
  type PillBehaviorInput,
  type PillBehaviorDataAttributes,
} from "./behavior";
export {
  PILL_CLASS,
  PILL_MARK_CLASS,
  PILL_BROKEN_CLASS,
  PILL_FOLDER_CLASS,
  PILL_ICON_CLASS,
  PILL_NAME_CLASS,
  PILL_REMOVE_CLASS,
  ICON_AREA_WIDTH,
} from "./constants";
export {
  FILE_ICON_DATA_URI,
  FOLDER_ICON_DATA_URI,
  CLOSE_ICON_DATA_URI,
  FILE_ICON_SVG,
  FOLDER_ICON_SVG,
  CLOSE_ICON_SVG,
} from "./icons";
