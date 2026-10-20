/** A command and what it acted on, laid out as one line. */
import type { ReactNode } from "react";

export function CommandTitle({ verb, parameter }: { verb: ReactNode; parameter?: ReactNode }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-[var(--chat-space-inline)]">
      <span className="shrink-0">{verb}</span>
      {parameter ? (
        <span className="flex min-w-0 items-baseline font-normal text-muted-foreground">
          {parameter}
        </span>
      ) : null}
    </span>
  );
}
