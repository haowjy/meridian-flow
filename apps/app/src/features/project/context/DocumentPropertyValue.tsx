import { Trans } from "@lingui/react/macro";
import type { JsonValue } from "@meridian/contracts/threads";

import { Chip } from "@/components/ui/chip";
import { isChipList, isEmptyValue } from "./property-shapes";

export function YamlBlock({ text }: { text: string }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-ink-fill px-2 py-1 font-mono text-xs text-foreground">
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
  source: string | null;
}) {
  if (isEmptyValue(value)) {
    return (
      <span className="text-muted-foreground">
        <Trans>Empty</Trans>
      </span>
    );
  }
  if (isChipList(value)) {
    return (
      <ul className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          // The same word can appear twice in a list, so the position keeps the keys apart.
          <li key={`${index}:${String(item)}`} className="flex">
            <Chip kind="label" className="font-normal text-foreground">
              {typeof item === "boolean" ? <Flag value={item} /> : String(item)}
            </Chip>
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "boolean") return <Flag value={value} />;
  if (typeof value === "object") return source === null ? null : <YamlBlock text={source} />;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}
