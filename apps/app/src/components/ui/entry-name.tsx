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
  if (!truncate)
    return (
      <>
        {name}
        {faint}
      </>
    );
  // The flex parts would read aloud as two words ("Kael ~2db3"); it is one name, as a chip says it.
  return (
    <>
      <span aria-hidden className="flex min-w-0">
        <span className="truncate">{name}</span>
        {faint}
      </span>
      <span className="sr-only">
        {name}~{suffix}
      </span>
    </>
  );
}
