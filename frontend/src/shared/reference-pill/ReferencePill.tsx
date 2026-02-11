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

export interface ReferencePillProps {
  displayName: string;
  iconType: "file" | "folder";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  documentPath?: string;
  broken?: boolean;
  className?: string;
}

export const ReferencePill = React.memo(function ReferencePill({
  displayName,
  iconType,
  onClick,
  documentPath,
  broken = false,
  className,
}: ReferencePillProps) {
  const Icon = iconType === "folder" ? Folder : FileText;
  const pillClass = [
    PILL_CLASS,
    broken ? PILL_BROKEN_CLASS : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      onClick={onClick}
      className={pillClass}
      title={documentPath ?? displayName}
      disabled={!onClick}
    >
      <Icon className={`${PILL_ICON_CLASS} size-3`} />
      <span className={PILL_NAME_CLASS}>{displayName}</span>
    </button>
  );
});
