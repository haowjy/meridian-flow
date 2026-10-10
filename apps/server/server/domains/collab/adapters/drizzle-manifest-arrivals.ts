/**
 * Today's manifest companion as a publication step: a draft's manifest push
 * publishes draft-created documents, and they arrive after text admission,
 * once, against the batch's tree (contract §9.4). Lane A's tree candidate
 * replaces this step.
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchWriteJournal } from "@meridian/database/schema";
import { and, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { manifestMembershipRowDocumentId } from "../domain/manifest-membership-journal.js";
import type { SettlementPublication } from "./drizzle-settlement-publication.js";

export function manifestArrivalPublication(
  db: Database,
  arrivals: DocumentArrivals,
): SettlementPublication {
  return {
    namespaces: {
      lockNamespaces: ({ documentIds, sourceIds }) =>
        arrivals.lockNamespaces(documentIds, sourceIds),
    },
    steps: [
      {
        kind: "manifest_arrivals",
        async plan(batch) {
          const arriving = await arrivingDocumentIds(
            db,
            batch.members.flatMap((member) => member.journalIds),
          );
          if (arriving.length === 0) return null;
          return {
            namespaceDocumentIds: arriving,
            async afterAdmission() {
              // Membership is published above, in this transaction: settle against it.
              await arrivals.settle(arriving);
            },
          };
        },
      },
    ],
  };
}

/** Documents whose live manifest entry the batch publishes, from immutable journal rows. */
async function arrivingDocumentIds(
  db: Database,
  journalIds: readonly number[],
): Promise<DocumentId[]> {
  if (journalIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({ updateMeta: branchWriteJournal.updateMeta })
    .from(branchWriteJournal)
    .where(
      and(
        inArray(branchWriteJournal.id, [...journalIds]),
        sql`${branchWriteJournal.updateMeta}->>'kind' = 'manifest_membership'`,
        sql`(${branchWriteJournal.updateMeta}->>'present')::boolean IS TRUE`,
      ),
    );
  return [...new Set(rows.flatMap((row) => manifestMembershipRowDocumentId(row) ?? []))].sort();
}
