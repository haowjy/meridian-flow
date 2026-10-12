/**
 * DocumentPropertyValue — one property's value, as the writer wrote it: words
 * and numbers plain, lists as chips, Yes and No for flags, and the writer's own
 * YAML text for maps and lists of maps. Display only.
 */
import { Trans } from "@lingui/react/macro";
import type { JsonValue } from "@meridian/contracts/threads";

import { isChipList, isEmptyValue } from "./property-shapes";

export function YamlBlock({ text }: { text: string }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-muted px-2 py-1 font-mono text-caption text-foreground">
      {text}
    </pre>
  );
}

function Flag({ value }: { value: boolean }) {
  return value ? <Trans>Yes</Trans> : <Trans>No</Trans>;
}

export function DocumentPropertyValue({
  value,
  source,
}: {
  value: JsonValue;
  /** The text the writer wrote for a list or map value. */
  source: string | null;
}) {
  if (isEmptyValue(value)) {
    return (
      <span className="text-ink-muted">
        <Trans>Empty</Trans>
      </span>
    );
  }
  if (isChipList(value)) {
    return (
      <ul className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          // The same word can appear twice in a list, so the position keeps the keys apart.
          <li
            key={`${index}:${String(item)}`}
            className="rounded-full border border-border-subtle bg-muted px-2 text-caption text-foreground"
          >
            {typeof item === "boolean" ? <Flag value={item} /> : String(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "boolean") return <Flag value={value} />;
  if (typeof value === "object") return source === null ? null : <YamlBlock text={source} />;
  // Numbers and dates are shown as written: a year is not "2,025".
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}
