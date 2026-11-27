import type { CommandDriver, CommandRecord, SubmitInput } from "@meridian/command-driver";
import { DeviceRefusedError, submitCommand } from "@/client/commands/submit";

export async function renameCommand(
  driver: CommandDriver | null,
  input: SubmitInput & { body: { title: string } & Record<string, unknown> },
  onRenamed?: (title: string) => void,
): Promise<void> {
  if (!driver || !input.body.title) return;
  const record = await submitCommand(driver, input);
  if (!record) throw new DeviceRefusedError();
  const settled = await driver.whenSettled(record.id);
  if (settled?.state === "done") return onRenamed?.(input.body.title);
  if (settled?.state !== "never") return;
  void driver.dismiss(record.id);
  throw new Error(`${input.kind} ended never`);
}

export function projectRenames<Item extends { id: string; title: string | null }>(
  records: readonly CommandRecord[],
  kind: string,
  targetOf: (body: unknown) => string,
  items: Item[],
): Item[] {
  const titles = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== kind) continue;
    if (record.state === "never" || (record.state === "done" && record.observed)) continue;
    titles.set(targetOf(record.body), (record.body as { title: string }).title);
  }
  if (titles.size === 0) return items;
  return items.map((item) => {
    const title = titles.get(item.id);
    return title === undefined || title === item.title ? item : { ...item, title };
  });
}
