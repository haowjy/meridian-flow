import type { ReactNode } from "react";
import { role } from "./roles";

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
