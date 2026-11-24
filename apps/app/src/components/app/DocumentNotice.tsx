import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DocumentNotice({
  icon,
  action,
  className,
  children,
}: {
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border-subtle bg-card py-1.5 pr-1.5 pl-3 text-sm",
        className,
      )}
    >
      <span className="flex shrink-0 items-center text-muted-foreground">{icon}</span>
      <p className="min-w-40 flex-1 text-muted-foreground">{children}</p>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}
