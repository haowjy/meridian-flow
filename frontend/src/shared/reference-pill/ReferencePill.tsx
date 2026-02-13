/**
 * Reference Pill — React Component
 *
 * For non-CM6 contexts (thread display, future React UIs).
 * Uses the same CSS classes as the DOM builder for visual consistency.
 */

import React from "react";
import { FileText, Folder } from "lucide-react";
import {
  PILL_CLASS,
  PILL_ICON_CLASS,
  PILL_NAME_CLASS,
  PILL_BROKEN_CLASS,
} from "./constants";
import {
  resolvePillBehavior,
  pillBehaviorToDataAttributes,
  type PillBehaviorInput,
} from "./behavior";

export interface ReferencePillProps {
  displayName: string;
  iconType: "file" | "folder";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  documentPath?: string;
  broken?: boolean;
  className?: string;
  behavior?: PillBehaviorInput;
}

export const ReferencePill = React.memo(function ReferencePill({
  displayName,
  iconType,
  onClick,
  documentPath,
  broken = false,
  className,
  behavior,
}: ReferencePillProps) {
  const Icon = iconType === "folder" ? Folder : FileText;
  const baseBehavior = resolvePillBehavior({
    canNavigate: Boolean(onClick),
    ...behavior,
  });
  // React pill currently supports navigation-only interactions.
  const finalBehavior = resolvePillBehavior({
    ...baseBehavior,
    canRemove: false,
  });
  const dataAttrs = pillBehaviorToDataAttributes(finalBehavior);
  const pillClass = [
    PILL_CLASS,
    broken ? PILL_BROKEN_CLASS : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const clickHandler = finalBehavior.canNavigate ? onClick : undefined;

  return (
    <button
      onClick={clickHandler}
      className={pillClass}
      title={documentPath ?? displayName}
      disabled={!clickHandler}
      {...dataAttrs}
    >
      <Icon className={`${PILL_ICON_CLASS} size-3`} />
      <span className={PILL_NAME_CLASS}>{displayName}</span>
    </button>
  );
});
