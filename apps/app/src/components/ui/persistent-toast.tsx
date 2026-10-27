/**
 * PersistentToast: the card a long-running operation owns until it ends and the
 * writer closes it. Title, a detail line, an optional bar (determinate or
 * indeterminate), body content, an actions row, a collapse control that folds
 * the card to one line (name and bar), and close.
 *
 * Presentational: the owner decides whether it is collapsible (`onCollapsedChange`)
 * and closable (`onClose`). `ToastRegion` stacks these; the card never takes
 * focus by itself.
 */
import { t } from "@lingui/core/macro";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type ReactNode, useId } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type PersistentToastProps = {
  title: string;
  detail?: ReactNode;
  /** 0 to 100, or "indeterminate". Omit for no bar. */
  progress?: number | "indeterminate";
  actions?: ReactNode;
  children?: ReactNode;
  collapsed?: boolean;
  /** Present: the card shows a collapse control. Absent: it is always expanded. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Present: the card shows a close control. */
  onClose?: () => void;
  /** Phone sheet: 44px controls. */
  touch?: boolean;
  className?: string;
};

/** The bar for a toast's `progress` value; the phone's compact bar reuses it. */
export function ToastBar({
  progress,
  label,
  className,
}: {
  progress: number | "indeterminate";
  label: string;
  className?: string;
}) {
  return progress === "indeterminate" ? (
    <Progress indeterminate label={label} className={className} />
  ) : (
    <Progress value={progress} label={label} className={className} />
  );
}

function ToastControl({
  label,
  touch,
  onClick,
  children,
}: {
  label: string;
  touch: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return touch ? (
    <PhoneIconButton aria-label={label} onClick={onClick}>
      {children}
    </PhoneIconButton>
  ) : (
    <IconButton tooltip={label} onClick={onClick}>
      {children}
    </IconButton>
  );
}

export function PersistentToast({
  title,
  detail,
  progress,
  actions,
  children,
  collapsed = false,
  onCollapsedChange,
  onClose,
  touch = false,
  className,
}: PersistentToastProps) {
  const titleId = useId();
  const Chevron = collapsed ? ChevronUp : ChevronDown;
  return (
    <article
      aria-labelledby={titleId}
      data-collapsed={collapsed || undefined}
      className={cn(
        "rounded-lg border border-border-subtle bg-card px-3 text-card-foreground shadow-card",
        collapsed ? "py-1.5" : "py-2.5",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <div
          id={titleId}
          title={collapsed ? title : undefined}
          className={cn(
            "min-w-0 flex-1 text-sm font-medium text-foreground",
            collapsed ? "truncate" : "break-words",
          )}
        >
          {title}
        </div>
        {collapsed && progress !== undefined ? (
          <ToastBar progress={progress} label={title} className="mx-1 h-1 w-14 shrink-0" />
        ) : null}
        {onCollapsedChange ? (
          <ToastControl
            touch={touch}
            label={collapsed ? t`Expand` : t`Collapse`}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            <Chevron aria-hidden className={touch ? "size-4" : undefined} />
          </ToastControl>
        ) : null}
        {onClose ? (
          <ToastControl touch={touch} label={t`Close`} onClick={onClose}>
            <X aria-hidden className={touch ? "size-4" : undefined} />
          </ToastControl>
        ) : null}
      </div>
      {collapsed ? null : (
        <>
          {detail ? <div className="mt-0.5 text-caption text-ink-muted">{detail}</div> : null}
          {progress !== undefined ? (
            <ToastBar progress={progress} label={title} className="mt-2 h-1" />
          ) : null}
          {children ? <div className="mt-2 text-caption text-ink-muted">{children}</div> : null}
          {actions ? (
            <div
              className={cn(
                "mt-3 flex flex-wrap justify-end gap-2",
                touch && "[&_[data-slot=button]]:min-h-11",
              )}
            >
              {actions}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
