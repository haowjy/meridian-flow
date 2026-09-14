/** Read-only v4 lineage import codec. Unsupported or malformed bytes remain recovery evidence. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { z } from "zod";

const revision = z.number().int().positive();
const id = z.string().min(1);
const scheme = z.enum(CONTEXT_URI_SCHEMES);
const created = z.strictObject({
  status: z.enum(["created", "already-materialized"]),
  documentId: id,
  scheme,
  path: z.string(),
  name: z.string(),
  workId: id.nullable().optional(),
});
const work = z.strictObject({
  workRevision: revision,
  home: z
    .strictObject({ scheme: z.literal("unfiled"), folderPath: z.string().optional() })
    .nullable(),
  desiredIdentity: z
    .strictObject({
      destination: z.strictObject({ scheme, folderPath: z.string(), workId: id.optional() }),
      name: z.string(),
    })
    .optional(),
  createSettlement: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ready") }),
    z.strictObject({ kind: z.literal("confirmation-required") }),
    z.strictObject({ kind: z.literal("confirmed"), result: created }),
  ]),
  failure: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("error"), name: z.string() }),
      z.strictObject({
        kind: z.literal("conflict"),
        name: z.string(),
        scheme,
        path: z.string(),
        workId: id.optional(),
      }),
    ])
    .optional(),
  pendingSinceMs: z.number().finite().nullable(),
});
const common = {
  version: z.literal(4),
  ref: z.strictObject({ accountId: id, projectId: id, lineageHandle: id }),
  envelopeRevision: revision,
};
const active = {
  active: z.strictObject({ documentId: id, identityRevision: revision }),
  work,
  aliases: z.record(
    id,
    z.strictObject({ publicationObligationId: id, introducedAtIdentityRevision: revision }),
  ),
};
const schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    ...active,
    kind: z.literal("local"),
    persistence: z.strictObject({ persistenceId: id, exactDatabaseName: id }),
  }),
  z.strictObject({
    ...common,
    ...active,
    kind: z.literal("adopted"),
    adoptionRevision: revision,
    canonicalSync: z
      .strictObject({
        kind: z.literal("canonical-sync"),
        obligationId: id,
        documentId: id,
        adoptionRevision: revision,
      })
      .optional(),
    publication: z
      .strictObject({
        kind: z.literal("tab-publication"),
        obligationId: id,
        lineageHandle: id,
        documentId: id,
        adoptionRevision: revision,
      })
      .optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("terminal"),
    documentId: id,
    terminalGeneration: id,
    transitionId: id,
    exactDatabaseName: id,
    cleanupObligationId: id,
  }),
]);

export type LegacyResourceRecord = z.infer<typeof schema>;
export type LegacyResourceBytes = { sourceKey: string; raw: string };
const PREFIX = "meridian:local-untitled-lineage:v3:";

/** Enumerate raw account-qualified keys; the old ledger's list() drops undecodable records. */
export function snapshotLegacyResources(
  accountId: string,
  storage: Storage,
): LegacyResourceBytes[] {
  const prefix = `${PREFIX}${encodeURIComponent(accountId)}:`;
  const records: LegacyResourceBytes[] = [];
  for (let index = 0; index < storage.length; index++) {
    const sourceKey = storage.key(index);
    if (!sourceKey?.startsWith(prefix)) continue;
    const raw = storage.getItem(sourceKey);
    if (raw !== null) records.push({ sourceKey, raw });
  }
  return records.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

export function decodeLegacyResource(
  accountId: string,
  source: LegacyResourceBytes,
): LegacyResourceRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(source.raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  const expectedKey =
    PREFIX +
    [record.ref.accountId, record.ref.projectId, record.ref.lineageHandle]
      .map(encodeURIComponent)
      .join(":");
  if (record.ref.accountId !== accountId || source.sourceKey !== expectedKey) return null;
  return record;
}
