import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { joinMain } from "./focus-on-open";

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
    if (joined && ref.current) return joinMain(ref.current, { text: false });
  }, [joined]);
  return (
    <div ref={ref} tabIndex={-1} role={role} className={cn("outline-none", className)}>
      {children}
    </div>
  );
}
