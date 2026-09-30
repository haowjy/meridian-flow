/** Bounded connected-conversation listing over spawn and cutoff-owner edges. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { z } from "zod";
import type { ThreadRepositories, ThreadStatusReader } from "../../threads/ports/repositories.js";
import { resolveReadableThread, threadReadError } from "./resolve-readable-thread.js";

export const ThreadLsInputSchema = z
  .object({
    ref: z.string().optional(),
    depth: z.number().int().min(1).max(3).default(1),
    cursor: z.string().optional(),
  })
  .strict();
export type ThreadLsInput = z.input<typeof ThreadLsInputSchema>;
const Cursor = z
  .object({
    v: z.literal(1),
    t: z.string(),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const LAST_ASKED_LIMIT = 100;

/** Compact local requester text for one model-facing list row. */
export function formatLastAsked(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(collapsed);
  if (characters.length <= LAST_ASKED_LIMIT) return JSON.stringify(collapsed);
  const candidate = characters.slice(0, LAST_ASKED_LIMIT - 1).join("");
  const boundary = candidate.lastIndexOf(" ");
  const shortened = (boundary > 0 ? candidate.slice(0, boundary) : candidate).trimEnd();
  return JSON.stringify(`${shortened}…`);
}

export async function listReadableThreads({
  repos,
  statusReader,
  caller,
  input,
}: {
  repos: Pick<ThreadRepositories, "threads" | "turns" | "readSnapshot">;
  statusReader: Pick<ThreadStatusReader, "readMany">;
  caller: Thread;
  input: ThreadLsInput;
}) {
  return repos.readSnapshot(async () => {
    const resolved = await resolveReadableThread({
      caller,
      ref: input.ref,
      threads: repos.threads,
    });
    if (!resolved.ok) return resolved;
    const target = resolved.target;
    let after: z.infer<typeof Cursor> | undefined;
    if (input.cursor) {
      try {
        after = Cursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
      } catch {
        return threadReadError("invalid_cursor", "Invalid conversation-list cursor");
      }
      if (after.t !== target.id)
        return threadReadError("invalid_cursor", "Cursor belongs to another conversation");
    }
    const path: Thread[] = [target];
    let node = target;
    for (let i = 0; i < 16; i++) {
      const up =
        node.kind === "subagent"
          ? node.parentThreadId
          : node.originTurnId
            ? (await repos.turns.findById(node.originTurnId as TurnId))?.threadId
            : null;
      if (!up) break;
      const parent = await repos.threads.findByIdIncludingDeleted(up as ThreadId);
      if (!parent) throw new Error(`Missing connected parent for ${node.id}`);
      path.unshift(parent);
      node = parent;
    }
    const label = (thread: Thread) => `${thread.ref}${thread.deletedAt ? " (in trash)" : ""}`;
    const edge = (thread: Thread) => (thread.kind === "subagent" ? "spawn" : thread.originType);
    const lines = [
      `${path.length === 17 && (node.parentThreadId || node.originTurnId) ? "… › " : ""}${path.map((row, i) => `${i ? `${edge(row)} ` : ""}${label(row)}`).join(" › ")}   (you are ${caller.ref})`,
    ];
    const nodes: Array<{ thread: Thread; level: number; upThreadId?: ThreadId }> = [
      { thread: target, level: 0 },
    ];
    let parents = [target];
    let remaining = 50;
    for (let level = 1; level <= (input.depth ?? 1) && parents.length && remaining > 0; level++) {
      const rows = await repos.threads.listLineageChildren({
        rootThreadId: target.rootThreadId,
        parentIds: parents.map((p) => p.id),
        limit: remaining + 1,
        ...(level === 1 && after ? { after } : {}),
      });
      const visible = rows.slice(0, remaining);
      nodes.push(...visible.map((thread) => ({ thread, level, upThreadId: thread.upThreadId })));
      if (rows.length > remaining) {
        if (level === 1) {
          const last = visible.at(-1) as (typeof visible)[number];
          const cursor = Buffer.from(
            JSON.stringify({ v: 1, t: target.id, createdAt: last.createdAt, id: last.id }),
          ).toString("base64url");
          lines.push(`…older: thread_ls(${JSON.stringify({ ref: target.ref, cursor })})`);
        } else {
          for (const parent of parents) {
            const sample =
              rows.find((row) => row.upThreadId === parent.id) ??
              (
                await repos.threads.listLineageChildren({
                  rootThreadId: target.rootThreadId,
                  parentIds: [parent.id],
                  limit: 1,
                })
              )[0];
            const shown = visible.filter((row) => row.upThreadId === parent.id).length;
            if (sample && sample.siblingCount > shown)
              lines.push(
                `…and ${sample.siblingCount - shown} more under ${parent.ref}: thread_ls(${JSON.stringify({ ref: parent.ref })})`,
              );
          }
        }
      }
      remaining -= visible.length;
      parents = visible;
      if (remaining === 0 && level < (input.depth ?? 1)) {
        for (const parent of parents) {
          const [sample] = await repos.threads.listLineageChildren({
            rootThreadId: target.rootThreadId,
            parentIds: [parent.id],
            limit: 1,
          });
          if (sample)
            lines.push(
              `…and ${sample.siblingCount} more under ${parent.ref}: thread_ls(${JSON.stringify({ ref: parent.ref })})`,
            );
        }
      }
    }
    const lastAsked = await repos.turns.listLatestLocalRequesterText(
      nodes.map((node) => node.thread.id as ThreadId),
    );
    const status = await statusReader.readMany(nodes.map((n) => n.thread.id));
    const render = (thread: Thread, level: number): string[] => {
      const snippet = lastAsked.get(thread.id as ThreadId);
      return [
        `${"  ".repeat(level)}${thread.ref}  ${status.has(thread.id) ? "awake" : "asleep"}  ${thread.spawnStatus ?? ""}  ${thread.title ?? ""}${level ? `  ${edge(thread)}` : ""}`,
        ...(snippet ? [`${"  ".repeat(level)}     last asked: ${formatLastAsked(snippet)}`] : []),
        ...nodes
          .filter((node) => node.upThreadId === thread.id)
          .flatMap((node) => render(node.thread, level + 1)),
      ];
    };
    const rendered = render(target, 0);
    return [lines[0], ...rendered, ...lines.slice(1)].join("\n");
  });
}
