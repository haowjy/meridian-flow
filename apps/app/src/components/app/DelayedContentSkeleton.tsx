import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePaintPending } from "./PaintHold";

export function DelayedContentSkeleton({ className }: { className?: string }) {
  usePaintPending();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className={cn("pointer-events-none px-6 py-8", className)} aria-hidden>
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-7 w-1/3 motion-reduce:animate-none" />
        <Skeleton className="mt-4 h-4 w-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-full motion-reduce:animate-none" />
        <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      </div>
    </div>
  );
}
