/**
 * HomeColumn — thin layout wrapper that pins the `home-column` Tier-2 utility
 * (max width + vertical padding) around Home content. No layout logic of its
 * own; exists so the Home column rhythm lives in one named class.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function HomeColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("home-column", className)}>{children}</div>;
}
