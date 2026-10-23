/** Backfill indexed folder aliases and normalize existing namespace collisions with the runtime rule. */
import {
  allocateFilename,
  folderDocumentName,
  type NamespaceNameClaim,
  renderFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import type postgres from "postgres";

type Node = {
  id: string;
  context_source_id: string;
  parent_id: string | null;
  kind: "document" | "folder";
  name: string;
  extension: string;
  hidden: boolean;
  created_at: Date;
};

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  // Deleted folders need the derived column too even though they do not claim a live name.
  const folders = await sql<
    { id: string; name: string }[]
  >`SELECT id, name FROM folders ORDER BY id`;
  for (const folder of folders) {
    await sql`UPDATE folders SET document_alias = ${folderDocumentName(folder.name)} WHERE id = ${folder.id}`;
  }

  const nodes = await sql<Node[]>`SELECT * FROM (
    SELECT d.id, d.context_source_id, d.folder_id AS parent_id, 'document'::text AS kind,
      d.name, d.extension, d.hidden, d.created_at
    FROM documents d WHERE d.deleted_at IS NULL
    UNION ALL
    SELECT f.id, f.context_source_id, f.parent_id, 'folder'::text AS kind,
      f.name, ''::text AS extension, f.hidden, f.created_at
    FROM folders f WHERE f.deleted_at IS NULL
  ) n ORDER BY context_source_id, parent_id NULLS FIRST, hidden ASC,
    (kind = 'folder') DESC, created_at ASC, id ASC`;

  const groups = new Map<string, Node[]>();
  for (const node of nodes) {
    const key = JSON.stringify([node.context_source_id, node.parent_id]);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const accepted: NamespaceNameClaim[] = [];
    for (const node of group) {
      const claim = (): NamespaceNameClaim => ({
        kind: node.kind,
        filename: node.kind === "document" ? renderFilename(node.name, node.extension) : node.name,
      });
      if (!accepted.some((other) => sameNamespaceName(claim(), other))) {
        accepted.push(claim());
        continue;
      }
      const filename = await allocateFilename(
        node.kind === "document"
          ? { kind: "document", name: node.name, extension: node.extension }
          : { kind: "folder", name: node.name },
        (candidate) =>
          group.some(
            (other) =>
              other.id !== node.id &&
              sameNamespaceName(candidate, {
                kind: other.kind,
                filename:
                  other.kind === "document"
                    ? renderFilename(other.name, other.extension)
                    : other.name,
              }),
          ),
      );
      if (node.kind === "document") {
        node.name = node.extension ? filename.slice(0, -(node.extension.length + 1)) : filename;
        await sql`UPDATE documents SET name = ${node.name}, updated_at = now(),
          location_version = location_version + 1 WHERE id = ${node.id}`;
      } else {
        node.name = filename;
        await sql`UPDATE folders SET name = ${filename}, document_alias = ${folderDocumentName(filename)},
          updated_at = now(), location_version = location_version + 1 WHERE id = ${node.id}`;
        await sql`WITH RECURSIVE tree(id) AS (SELECT ${node.id}::uuid UNION ALL
          SELECT f.id FROM folders f JOIN tree p ON f.parent_id = p.id)
          UPDATE folders SET location_version = location_version + 1
          WHERE id IN (SELECT id FROM tree WHERE id <> ${node.id}::uuid)`;
        await sql`WITH RECURSIVE tree(id) AS (SELECT ${node.id}::uuid UNION ALL
          SELECT f.id FROM folders f JOIN tree p ON f.parent_id = p.id)
          UPDATE documents SET location_version = location_version + 1
          WHERE folder_id IN (SELECT id FROM tree)`;
      }
      accepted.push(claim());
    }
  }
}
