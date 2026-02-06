/**
 * ToolArgsStreamTracker
 *
 * Best-effort, incremental tracker for AG-UI TOOL_CALL_ARGS JSON streams.
 *
 * AG-UI streams tool arguments as raw JSON text chunks via `TOOL_CALL_ARGS.delta`.
 * The protocol does not include an "arg name/path" per chunk, so the UI must infer
 * which argument is currently streaming.
 *
 * This tracker scans ONLY the incoming deltas (O(len(delta)) per event) and maintains
 * a tiny JSON tokenizer state machine to infer:
 * - total bytes received (approx; JS string length)
 * - currently streaming top-level key whose value is a string (e.g. `content`)
 * - chars received for that value + small head/tail preview
 *
 * Scope: top-level object keys only. Nested paths are intentionally out of scope.
 */

export interface ToolArgsStreamSnapshot {
  totalBytes: number;
  activeArgKey: string | null;
  activeArgChars: number;
  previewHead: string;
  previewTail: string;
}

const DEFAULT_MAX_KEY_CHARS = 96;
const DEFAULT_PREVIEW_CHARS = 96;

export class ToolArgsStreamTracker {
  private readonly maxKeyChars: number;
  private readonly previewChars: number;

  private totalBytes = 0;

  // JSON scanning state
  private depth = 0;
  private inString = false;
  private escapeNext = false;

  // Top-level object key parsing state
  private expectTopLevelKey = false;
  private readingKey = false;
  private keyBuffer = "";
  private lastKey: string | null = null;
  private expectColonForKey = false;
  private expectValueForKey = false;

  // Active string value tracking (top-level key only)
  private activeArgKey: string | null = null;
  private activeArgChars = 0;
  private previewHead = "";
  private previewTail = "";

  constructor(opts?: { maxKeyChars?: number; previewChars?: number }) {
    this.maxKeyChars = opts?.maxKeyChars ?? DEFAULT_MAX_KEY_CHARS;
    this.previewChars = opts?.previewChars ?? DEFAULT_PREVIEW_CHARS;
  }

  snapshot(): ToolArgsStreamSnapshot {
    return {
      totalBytes: this.totalBytes,
      activeArgKey: this.activeArgKey,
      activeArgChars: this.activeArgChars,
      previewHead: this.previewHead,
      previewTail: this.previewTail,
    };
  }

  append(delta: string): ToolArgsStreamSnapshot {
    if (!delta) return this.snapshot();

    // Defensive cap to prevent overflow for extremely large streams
    this.totalBytes = Math.min(
      this.totalBytes + delta.length,
      Number.MAX_SAFE_INTEGER,
    );

    for (let i = 0; i < delta.length; i++) {
      const ch = delta.charAt(i);

      if (this.inString) {
        if (this.escapeNext) {
          this.escapeNext = false;
          this.onStringChar(ch);
          continue;
        }

        if (ch === "\\") {
          this.escapeNext = true;
          this.onStringChar(ch);
          continue;
        }

        if (ch === '"') {
          // String ends
          this.inString = false;
          this.onStringEnd();
          continue;
        }

        this.onStringChar(ch);
        continue;
      }

      // Not inside a string
      if (ch === '"') {
        this.inString = true;
        this.escapeNext = false;
        this.onStringStart();
        continue;
      }

      // Skip whitespace outside strings for readability
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
        continue;
      }

      // Structural tokens (outside strings)
      if (ch === "{") {
        this.depth++;
        // When entering the top-level object, expect a key next.
        if (this.depth === 1) {
          this.expectTopLevelKey = true;
          this.lastKey = null;
          this.expectColonForKey = false;
          this.expectValueForKey = false;
        }
        continue;
      }
      if (ch === "}") {
        if (this.depth === 1) {
          // Exiting top-level object; no active arg.
          this.activeArgKey = null;
        }
        this.depth = Math.max(0, this.depth - 1);
        // After closing an object at depth 1, we're not expecting a key unless a comma follows.
        if (this.depth < 1) {
          this.expectTopLevelKey = false;
        }
        continue;
      }
      if (ch === "[") {
        this.depth++;
        continue;
      }
      if (ch === "]") {
        this.depth = Math.max(0, this.depth - 1);
        continue;
      }
      if (ch === ",") {
        // At top-level object, next token should be a key.
        if (this.depth === 1) {
          this.expectTopLevelKey = true;
          this.lastKey = null;
          this.expectColonForKey = false;
          this.expectValueForKey = false;
        }
        continue;
      }
      if (ch === ":" && this.depth === 1 && this.expectColonForKey) {
        this.expectColonForKey = false;
        this.expectValueForKey = true;
        continue;
      }

      // For non-string values: when we see any non-whitespace token as the value start,
      // we can clear "expectValueForKey". We only track active arg for string values.
      if (this.depth === 1 && this.expectValueForKey) {
        this.expectValueForKey = false;
        // If value starts with a non-quote token, it's not a string; no active arg.
        this.activeArgKey = null;
        continue;
      }
    }

    return this.snapshot();
  }

  private onStringStart(): void {
    if (this.depth !== 1) return;

    if (this.expectTopLevelKey) {
      this.readingKey = true;
      this.keyBuffer = "";
      return;
    }

    if (this.expectValueForKey && this.lastKey) {
      // Top-level string value begins.
      this.activeArgKey = this.lastKey;
      this.activeArgChars = 0;
      this.previewHead = "";
      this.previewTail = "";
      this.expectValueForKey = false;
    }
  }

  private onStringChar(ch: string): void {
    if (this.depth !== 1) return;

    if (this.readingKey) {
      if (this.keyBuffer.length < this.maxKeyChars) {
        this.keyBuffer += ch;
      }
      return;
    }

    if (this.activeArgKey) {
      // We count raw chars (including escape sequences) as a best-effort measure.
      this.activeArgChars++;

      if (this.previewHead.length < this.previewChars) {
        this.previewHead += ch;
      }

      // Maintain tail as a sliding window
      if (this.previewChars > 0) {
        this.previewTail += ch;
        if (this.previewTail.length > this.previewChars) {
          this.previewTail = this.previewTail.slice(
            this.previewTail.length - this.previewChars,
          );
        }
      }
    }
  }

  private onStringEnd(): void {
    if (this.depth !== 1) return;

    if (this.readingKey) {
      this.readingKey = false;
      this.lastKey = this.keyBuffer;
      this.keyBuffer = "";
      this.expectTopLevelKey = false;
      this.expectColonForKey = true;
      return;
    }

    if (this.activeArgKey) {
      // Value string ended; no longer "currently streaming".
      this.activeArgKey = null;
    }
  }
}
