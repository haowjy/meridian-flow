/**
 * The write-mode notice: one quiet line for something the writer did, where they
 * switched how the AI writes. It is a writer-action notice, not a compaction: no
 * mark, no rule, a small icon for the mode.
 *
 * The applied switch is a turn, so it keeps its place on reload. The same line
 * stands for the pending switch at the transcript tail (`QueuedControlRows`),
 * where it carries Stop, Retry and the failure words as `children`.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { FilePen, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { writeModeSwitchedCopy } from "./control-copy";
import { readWriteModeSwitch } from "./write-mode-model";

export function WriteModeNotice({
  mode,
  label,
  children,
}: {
  mode: AiWriteMode;
  label: string;
  /** Actions or follow-up words after the label. */
  children?: ReactNode;
}) {
  const Icon = mode === "draft" ? FilePen : Zap;
  return (
    <div
      data-write-mode-notice
      data-write-mode={mode}
      // Tall as a Stop button's line, so the pending notice, the applied bridge and the
      // switch turn that replaces them are one height: nothing below moves.
      className="flex min-h-[calc(var(--text-meta--line-height)+0.5rem+var(--chat-space-block)*2)] min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)] py-[var(--chat-space-block)]"
    >
      <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        <Icon aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
        <span className="min-w-0 text-meta text-ink-muted">{label}</span>
      </span>
      {children}
    </div>
  );
}

/** A switch turn in the transcript. */
export function AppliedWriteModeNotice({ turn }: { turn: Turn }) {
  const facts = readWriteModeSwitch(turn);
  if (!facts) return null;
  return <WriteModeNotice mode={facts.mode} label={writeModeSwitchedCopy(facts.mode)} />;
}
