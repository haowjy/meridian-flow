/**
 * StreamingText — Zone 3 of the live turn: renders the streaming answer text
 * with a trailing animated caret via `Markdown`.
 *
 * In DEV with the playback knob set, wraps the view in a throttled replay
 * (`streaming-text-dev`). Owns only the streaming-text presentation. Reasoning
 * frontier text renders via `ProcessDisclosure` / `TurnBlockStep`, not here.
 */
import { Markdown } from "@/rich-content/Markdown";
import { readDebugStreamPlaybackCps, useDebugStreamPlayback } from "./streaming-text-dev";

export type StreamingTextProps = {
  text: string;
};

export function StreamingText(props: StreamingTextProps) {
  if (import.meta.env.DEV && readDebugStreamPlaybackCps() > 0) {
    return <StreamingTextWithPlayback {...props} />;
  }
  return <StreamingTextView {...props} />;
}

function StreamingTextWithPlayback({ text }: StreamingTextProps) {
  const cps = readDebugStreamPlaybackCps();
  return <StreamingTextView text={useDebugStreamPlayback(text, cps)} />;
}

function StreamingTextView({ text }: StreamingTextProps) {
  return (
    <div className="[&:not(:last-child)]:mb-3">
      <Markdown mode="streaming">{text}</Markdown>
      <span aria-hidden className="mt-1 block">
        <StreamCaret />
      </span>
    </div>
  );
}

function StreamCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-2 translate-y-[2px] rounded-[1px] bg-primary motion-safe:animate-[blink_1.05s_step-end_infinite]"
      style={{ animationName: "blink" }}
    />
  );
}
