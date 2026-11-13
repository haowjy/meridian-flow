/**
 * The import's reveal: one `submit` of `create` records for every planned node, in the
 * transaction that marks the import finished. The texts are already in the journal under the
 * ids the nodes carry; the `documents` rows are written by the admission, like any create's.
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  type CreateRecord,
  childrenOf,
  LIVE,
  sourceRoot,
  type TreeRecordInput,
} from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { ensureProjectContextSource } from "../context-source-provisioning.js";
import type { ContextImportReveal, ImportRevealNode } from "../ports/context-import-reveal.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type { AheadRegistration, LinkAheadRegistry } from "../ports/link-ahead-registry.js";
import type { TreeListStore } from "../ports/tree-list-store.js";
import { lockNamespaceKeys } from "./context-fs/document-locations.js";
import { resolveCanonicalAddresses } from "./document-address.js";

const BATCH = 500;

const byName = (a: ImportRevealNode, b: ImportRevealNode) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;

export function createDrizzleContextImportReveal(deps: {
  db: Database;
  tree: Pick<TreeListStore, "submit">;
  ahead: Pick<LinkAheadRegistry, "registerWithinTransaction">;
  arrivals: Pick<DocumentArrivals, "settle">;
}): ContextImportReveal {
  return {
    async reveal({ projectId, nodes }) {
      const sourceOf = new Map<string, string>();
      for (const area of new Set(nodes.map((node) => node.area)))
        sourceOf.set(area, await ensureProjectContextSource(deps.db, projectId, area, ""));

      const planned = new Map(nodes.map((node) => [node.id, node]));
      const inside = new Map<string, ImportRevealNode[]>();
      const tops = new Map<string, ImportRevealNode[]>();
      for (const node of nodes) {
        const folder = node.parentId !== null && planned.get(node.parentId)?.kind === "folder";
        const group = folder
          ? inside.get(node.parentId as string)
          : tops.get(JSON.stringify([node.area, node.parentId]));
        if (group) group.push(node);
        else if (folder) inside.set(node.parentId as string, [node]);
        else tops.set(JSON.stringify([node.area, node.parentId]), [node]);
      }

      const { result: created } = await deps.tree.submit({
        list: { kind: "project", projectId },
        make(writer) {
          const view = writer.view(LIVE);
          const records: CreateRecord[] = [];
          // A parent's record comes before its children's; the top level arrives after what the
          // folder already holds, and a new folder's children rank in name order.
          const place = (
            kids: ImportRevealNode[],
            parent: string,
            source: string,
            after: string | null,
          ) => {
            let last = after;
            for (const node of kids.sort(byName)) {
              last = generateKeyBetween(last, null);
              const base = {
                type: "create",
                node: node.id,
                name: node.name,
                parent,
                source,
                rank: last,
              } as const;
              const input: TreeRecordInput =
                node.kind === "folder"
                  ? { ...base, kind: "folder" }
                  : node.kind === "file"
                    ? { ...base, kind: "file", blob: node.blob }
                    : {
                        ...base,
                        kind: "document",
                        filetype: node.filetype,
                        ...(node.aliases.length > 0 ? { aliases: node.aliases } : {}),
                        ...(node.properties ? { hasProperties: true as const } : {}),
                      };
              records.push(writer.author(LIVE, "system", input) as CreateRecord);
              if (node.kind === "folder") place(inside.get(node.id) ?? [], node.id, source, null);
            }
          };
          for (const [key, kids] of tops) {
            const [area, parentId] = JSON.parse(key) as [string, string | null];
            const source = sourceOf.get(area) as string;
            const parent = parentId ?? sourceRoot(source);
            place(kids, parent, source, childrenOf(view, parent).at(-1)?.rank ?? null);
          }
          return { records, result: records.map((record) => record.node) };
        },
      });

      const tx = currentDrizzleDb(deps.db);
      // What the create records do not carry: the document's properties, and a binary's preview.
      const facts = nodes.flatMap((node) => {
        if (node.kind === "file")
          return node.hasPreview ? [{ id: node.id, metadata: {}, hasPreview: true }] : [];
        if (node.kind !== "document" || (!node.properties && node.aliases.length === 0)) return [];
        return [
          {
            id: node.id,
            metadata: {
              ...(node.properties ? { properties: node.properties } : {}),
              ...(node.aliases.length > 0 ? { aliases: node.aliases } : {}),
            },
            hasPreview: false,
          },
        ];
      });
      for (let offset = 0; offset < facts.length; offset += BATCH) {
        const rows = facts
          .slice(offset, offset + BATCH)
          .map(
            (fact) =>
              sql`(${fact.id}::uuid, ${JSON.stringify(fact.metadata)}::jsonb, ${fact.hasPreview}::boolean)`,
          );
        await tx.execute(sql`
          UPDATE documents d SET
            metadata = CASE WHEN v.metadata = '{}'::jsonb THEN d.metadata ELSE v.metadata END,
            has_preview = d.has_preview OR v.has_preview
          FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, metadata, has_preview)
          WHERE d.id = v.id`);
      }

      const registrations: AheadRegistration[] = nodes.flatMap((node) =>
        node.kind === "document"
          ? node.aheadMints.map((mint) => ({
              aheadId: mint.ref.slice("ahead:".length),
              holderProjectId: mint.holderProjectId as AheadRegistration["holderProjectId"],
              address: mint.address,
            }))
          : [],
      );
      if (registrations.length > 0) {
        const targets = await resolveCanonicalAddresses(deps.db, registrations);
        await lockNamespaceKeys(
          deps.db,
          targets.map((target) => ({ ...target, workId: target.lockWorkId })),
        );
        await deps.ahead.registerWithinTransaction(registrations);
      }
      await deps.arrivals.settle(
        created.filter((id) => planned.get(id)?.kind !== "folder") as DocumentId[],
      );
    },
  };
}
