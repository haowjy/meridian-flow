/**
 * MobileEntryActionsMenu — phone `...` trailing button for file/folder rows
 * in MobileContextBrowser. Opens a dropdown with Rename and Delete actions.
 *
 * Phone chrome: 44px touch-target button using the canonical context overflow
 * adapter shared with the desktop tree.
 */
import { type EntryAction, EntryKebabButton } from "../context/ContextEntryActions";
import { mobileContextTreeOverflowTriggerClassName } from "../context/context-row-geometry";

export function MobileEntryActionsMenu({ onAction }: { onAction: (action: EntryAction) => void }) {
  return (
    <EntryKebabButton
      allowCreate={false}
      align="end"
      sideOffset={6}
      className={mobileContextTreeOverflowTriggerClassName}
      onAction={onAction}
    />
  );
}
