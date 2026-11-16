import type { ReactNode } from "react";
import { role } from "./roles";

/**
 * A document's or folder's name, and after it, faint, a twin's `~id`: the name spelled as its path
 * segment, so two of the same name in one folder tell apart. Inline, it wraps as prose does (a
 * chip); `truncate` cuts a long name and keeps the suffix, for a one-line row.
 */
export function EntryName({
  name,
  suffix,
  truncate = false,
}: {
  name: ReactNode;
  suffix?: string | undefined;
  truncate?: boolean;
}) {
  if (!suffix) return name;
  const faint = <span className={`shrink-0 ${role.secondary}`}>~{suffix}</span>;
  return truncate ? (
    <span className="flex min-w-0">
      <span className="truncate">{name}</span>
      {faint}
    </span>
  ) : (
    <>
      {name}
      {faint}
    </>
  );
}
