/**
 * ChatColumn — thin layout wrapper that pins the `chat-column` Tier-2 utility
 * (max width + horizontal padding) around chat content. No layout logic of its
 * own; exists so the column rhythm lives in one named class.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ChatColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("chat-column", className)}>{children}</div>;
}
