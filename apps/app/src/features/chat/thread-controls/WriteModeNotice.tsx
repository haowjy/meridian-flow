import type { Turn } from "@meridian/contracts/protocol";
import { readWriteModeSwitch } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { FilePen, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { writeModeSwitchedCopy } from "./control-copy";

export function WriteModeNotice({
  mode,
  label,
  children,
}: {
  mode: AiWriteMode;
  label: string;
  children?: ReactNode;
}) {
  const Icon = mode === "draft" ? FilePen : Zap;
  return (
    <div
      data-write-mode-notice
      data-write-mode={mode}
      className="flex min-h-(--write-mode-row) min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)] py-[var(--chat-space-block)]"
    >
      <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
      </span>
      {children}
    </div>
  );
}

export function AppliedWriteModeNotice({ turn }: { turn: Turn }) {
  const facts = readWriteModeSwitch(turn);
  if (!facts) return null;
  return <WriteModeNotice mode={facts.mode} label={writeModeSwitchedCopy(facts.mode)} />;
}
