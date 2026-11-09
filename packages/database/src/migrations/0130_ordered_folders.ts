/**
 * Give every visible child a stored rank, so every parent is ordered by rank.
 *
 * A name-ordered ("default") parent gets ranks in the order it displays today: folders first,
 * then numeric-aware displayed names, then id. A "manual" parent keeps its ranks and only ranks
 * children whose rank is null, which sorted first, before its first ranked child. Policy columns
 * are left for the SQL half to drop, so a rerun after a crash computes the same ranks.
 */
import { generateNKeysBetween } from "fractional-indexing";
import type postgres from "postgres";

// Frozen copy of the display order's collation (`compareDefaultSiblings`).
const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type Child = { kind: "folder" | "file"; id: string; name: string; rank: string | null };

const byDefaultOrder = (left: Child, right: Child): number => {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  const byName = NAME_ORDER.compare(left.name, right.name);
  if (byName !== 0) return byName;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const byRank = (left: Child, right: Child): number => {
  const leftRank = left.rank ?? "";
  const rightRank = right.rank ?? "";
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  const sources = await sql<
    { id: string; order_policy: string }[]
  >`SELECT id, order_policy FROM context_sources ORDER BY id`;
  for (const source of sources) {
    const folders = await sql<
      {
        id: string;
        parent_id: string | null;
        name: string;
        rank: string | null;
        order_policy: string;
        visible: boolean;
      }[]
    >`SELECT id, parent_id, name, rank, order_policy, (deleted_at IS NULL AND NOT hidden) AS visible
      FROM folders WHERE context_source_id = ${source.id}`;
    const documents = await sql<
      {
        id: string;
        folder_id: string | null;
        name: string;
        extension: string;
        rank: string | null;
      }[]
    >`SELECT id, folder_id, name, extension, rank FROM documents
      WHERE context_source_id = ${source.id} AND deleted_at IS NULL AND NOT hidden`;

    const policy = new Map<string | null, string>([[null, source.order_policy]]);
    const children = new Map<string | null, Child[]>();
    const adopt = (parentId: string | null, child: Child) => {
      const list = children.get(parentId);
      if (list) list.push(child);
      else children.set(parentId, [child]);
    };
    for (const folder of folders) {
      policy.set(folder.id, folder.order_policy);
      if (folder.visible)
        adopt(folder.parent_id, {
          kind: "folder",
          id: folder.id,
          name: folder.name,
          rank: folder.rank,
        });
    }
    for (const document of documents)
      adopt(document.folder_id, {
        kind: "file",
        id: document.id,
        name: document.extension ? `${document.name}.${document.extension}` : document.name,
        rank: document.rank,
      });

    for (const [parentId, siblings] of children) {
      const ranks = new Map<string, string>();
      if (policy.get(parentId) === "manual") {
        siblings.sort(byRank);
        const unranked = siblings.filter((child) => child.rank === null);
        const first = siblings.find((child) => child.rank !== null);
        const keys = generateNKeysBetween(null, first?.rank ?? null, unranked.length);
        for (const [index, child] of unranked.entries()) ranks.set(child.id, keys[index] as string);
      } else {
        siblings.sort(byDefaultOrder);
        const keys = generateNKeysBetween(null, null, siblings.length);
        for (const [index, child] of siblings.entries()) ranks.set(child.id, keys[index] as string);
      }
      for (const [kind, table] of [
        ["folder", sql("folders")],
        ["file", sql("documents")],
      ] as const) {
        const rows = siblings.flatMap((child) =>
          child.kind === kind && ranks.has(child.id)
            ? [{ id: child.id, rank: ranks.get(child.id) as string }]
            : [],
        );
        if (rows.length === 0) continue;
        await sql`UPDATE ${table} t SET rank = x.rank
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS x(id uuid, rank text)
          WHERE t.id = x.id`;
      }
    }
  }
}
