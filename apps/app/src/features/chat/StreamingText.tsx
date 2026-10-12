/**
 * StreamingText renders assistant prose through one stable Markdown tree;
 * only the trailing caret disappears at settlement.
 *
 * In DEV with the playback knob set, wraps the view in a throttled replay
 * (`streaming-text-dev`). Owns only the streaming-text presentation. Reasoning
 * renders via `TurnBlockStep` inside the process fold, not here.
 */
import { Markdown } from "@/rich-content/Markdown";
import { readDebugStreamPlaybackCps, useDebugStreamPlayback } from "./streaming-text-dev";

export type StreamingTextProps = {
  text: string;
  streaming?: boolean;
};

export function StreamingText(props: StreamingTextProps) {
  if (import.meta.env.DEV && readDebugStreamPlaybackCps() > 0) {
    return <StreamingTextWithPlayback {...props} />;
  }
  return <StreamingTextView {...props} />;
}

function StreamingTextWithPlayback({ text, streaming = true }: StreamingTextProps) {
  const cps = readDebugStreamPlaybackCps();
  const displayed = useDebugStreamPlayback(text, cps);
  return <StreamingTextView text={displayed} streaming={streaming || displayed !== text} />;
}

function StreamingTextView({ text, streaming = true }: StreamingTextProps) {
  return (
    <div>
      <Markdown mode={streaming ? "streaming" : "static"}>{text}</Markdown>
      {streaming && (
        <span aria-hidden className="mt-[var(--chat-space-inline)] block">
          <StreamCaret />
        </span>
      )}
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
