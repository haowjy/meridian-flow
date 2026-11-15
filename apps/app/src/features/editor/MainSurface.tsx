import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { joinMain } from "./focus-on-open";

/**
 * What main shows in place of an editor (a failure, a viewer): while `joined` it is main's
 * surface, so the focus main gives (`focusMain`) lands on its first control, or on it.
 */
export function MainSurface({
  joined,
  className,
  role,
  children,
}: {
  joined: boolean;
  className?: string;
  role?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (joined && ref.current) return joinMain(ref.current);
  }, [joined]);
  return (
    <div ref={ref} tabIndex={-1} role={role} className={cn("outline-none", className)}>
      {children}
    </div>
  );
}
