import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ChatColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("chat-column", className)}>{children}</div>;
}
