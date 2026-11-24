import { t } from "@lingui/core/macro";
import { CircleAlert, Info, X } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type FailureCardProps = {
  tone: "error" | "info";
  children: ReactNode;
  note?: ReactNode;
  inline?: boolean;
  announce?: boolean;
  onDismiss?: () => void;
};

export function FailureCard({
  tone,
  children,
  note,
  inline = false,
  announce = true,
  onDismiss,
}: FailureCardProps) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      role={announce ? (tone === "error" ? "alert" : "status") : undefined}
      className={cn(
        tone === "error"
          ? "border-destructive-border bg-destructive-tint"
          : "border-border bg-ink-fill",
        "rounded-lg py-[var(--chat-card-pad-y)] shadow-none",
        inline
          ? "w-fit px-[var(--chat-space-block)] has-[>svg]:gap-x-2"
          : "px-[var(--chat-card-pad-x)]",
      )}
    >
      <Icon
        className={tone === "error" ? "text-destructive" : "text-muted-foreground"}
        aria-hidden
      />
      <AlertDescription className="text-compact text-muted-foreground">
        <div
          className={cn(
            "flex items-center",
            inline
              ? "flex-nowrap gap-x-[var(--chat-space-inline)] whitespace-nowrap"
              : "w-full flex-wrap gap-x-[var(--chat-space-block)] gap-y-1",
          )}
        >
          {children}
          {onDismiss ? (
            <IconButton
              className="ml-auto shrink-0 coarse:-my-2.5"
              label={t`Dismiss`}
              onClick={onDismiss}
            >
              <X aria-hidden />
            </IconButton>
          ) : null}
        </div>
        {note}
      </AlertDescription>
    </Alert>
  );
}
