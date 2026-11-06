/** The one line a resolved ask leaves on its asking turn, or this device's answer while it sends. */
import { t } from "@lingui/core/macro";
import type { PermissionAskPayload } from "@meridian/contracts/threads";
import type { AskReceipt as AskReceiptFacts } from "@meridian/thread-client";
import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { useAskReceipt } from "@/client/stores";
import { cn } from "@/lib/utils";
import { permissionRequestText } from "./permission-request";

export function AskReceipt({ threadId, turnId }: { threadId: string; turnId: string }) {
  const receipt = useAskReceipt(threadId, turnId);
  if (!receipt) return null;
  const { ask, pending } = receipt;
  const Icon = ask.kind === "question" ? MessageCircleQuestion : ShieldCheck;
  const asked = ask.kind === "question" ? ask.payload.question : permissionAsked(ask.payload);
  return (
    <p
      className="flex min-w-0 items-start gap-[var(--chat-space-inline)] text-compact"
      data-ask-receipt=""
      data-ask-pending={pending ? "" : undefined}
    >
      <Icon className="mt-1 size-3.5 shrink-0 text-ink-subtle" aria-hidden />
      {/* Inline, so a narrow column wraps the answer under the question instead of cutting both. */}
      <span className="line-clamp-2 min-w-0">
        <span className="text-muted-foreground">{asked}</span>{" "}
        <span className={cn("font-medium text-foreground", pending && "opacity-60")}>
          {answerText(receipt)}
        </span>
        {pending ? (
          <>
            <span className="sr-only">{t`Sending`}</span>
            <span
              aria-hidden
              className="ml-[var(--chat-space-inline)] inline-block size-1.5 -translate-y-px rounded-full bg-status-live-foreground align-middle motion-safe:animate-pulse"
            />
          </>
        ) : null}
      </span>
    </p>
  );
}

function answerText({ resolution }: AskReceiptFacts): string {
  switch (resolution.kind) {
    case "option":
      return resolution.label;
    case "text":
      return resolution.text;
    case "skipped":
      return t`Skipped`;
    case "timeout":
      return resolution.label ? t`No answer, went with ${resolution.label}` : t`No answer`;
    case "cancelled":
      return t`Withdrawn`;
    case "allow":
      return t`Allowed`;
    case "allow_always":
      return t`Allowed always`;
    case "deny":
      return t`Denied`;
  }
}

function permissionAsked(payload: PermissionAskPayload): string {
  const { title, details } = permissionRequestText(payload);
  return [title, ...details].join(" · ");
}
