import type { ProjectId, UserId } from "@meridian/contracts";
import { nextFreeName } from "@meridian/contracts/mcp";
import type { Database } from "@meridian/database";
import { mcpConnections, mcpConnectionTokens, mcpPins, users } from "@meridian/database/schema";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../../shared/drizzle-transaction.js";
import type {
  ConnectionRow,
  ConnectionStore,
  PinRecord,
  StoredConnection,
} from "../../ports/connection-store.js";

type ConnectionRecord = typeof mcpConnections.$inferSelect;
type PinRecordRow = typeof mcpPins.$inferSelect;

const toRow = (row: ConnectionRecord): ConnectionRow => ({
  id: row.id,
  accountId: row.accountId,
  projectId: row.projectId,
  name: row.name,
  spec: row.spec,
  currentPinId: row.currentPinId,
  settingsVersion: row.settingsVersion,
  status: row.status,
  statusReason: row.statusReason,
  statusVersion: row.statusVersion,
  statusStartedAt: row.statusStartedAt,
  checkFinishedAt: row.checkFinishedAt,
  deletedAt: row.deletedAt,
});

const toPin = (row: PinRecordRow): PinRecord => ({
  id: row.id,
  connectionId: row.connectionId,
  pin: row.pin,
  createdAt: row.createdAt,
});

export function createDrizzleConnectionStore({ db }: { db: Database }): ConnectionStore {
  async function hydrate(conn: DrizzleDb, rows: ConnectionRecord[]): Promise<StoredConnection[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const pinIds = rows.flatMap((row) => (row.currentPinId ? [row.currentPinId] : []));
    const [pins, tokens] = await Promise.all([
      pinIds.length ? conn.select().from(mcpPins).where(inArray(mcpPins.id, pinIds)) : [],
      conn
        .select({ connectionId: mcpConnectionTokens.connectionId })
        .from(mcpConnectionTokens)
        .where(inArray(mcpConnectionTokens.connectionId, ids)),
    ]);
    const pinById = new Map(pins.map((pin) => [pin.id, toPin(pin)]));
    const withToken = new Set(tokens.map((token) => token.connectionId));
    return rows.map((row) => ({
      row: toRow(row),
      pin: row.currentPinId ? (pinById.get(row.currentPinId) ?? null) : null,
      tokenSet: withToken.has(row.id),
    }));
  }

  const liveNames = async (
    conn: DrizzleDb,
    row: { accountId: UserId; projectId: ProjectId | null },
  ) => {
    const taken = await conn
      .select({ name: mcpConnections.name })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.accountId, row.accountId),
          row.projectId
            ? eq(mcpConnections.projectId, row.projectId)
            : isNull(mcpConnections.projectId),
          isNull(mcpConnections.deletedAt),
        ),
      );
    return new Set(taken.map(({ name }) => name));
  };

  // Not FOR UPDATE: that conflicts with the key-share lock every insert referencing users takes.
  const lockAccount = (conn: DrizzleDb, accountId: UserId) =>
    conn.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("no key update");

  return {
    async listLive(accountId, projectId) {
      const rows = await db
        .select()
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.accountId, accountId),
            isNull(mcpConnections.deletedAt),
            projectId
              ? or(isNull(mcpConnections.projectId), eq(mcpConnections.projectId, projectId))
              : isNull(mcpConnections.projectId),
          ),
        )
        .orderBy(mcpConnections.name);
      const stored = await hydrate(db, rows);
      return {
        account: stored.filter((entry) => entry.row.projectId === null),
        project: stored.filter((entry) => entry.row.projectId !== null),
      };
    },

    async find(accountId, id) {
      const [row] = await db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.id, id), eq(mcpConnections.accountId, accountId)));
      return row ? ((await hydrate(db, [row]))[0] ?? null) : null;
    },

    add(input) {
      return db.transaction(async (tx) => {
        await lockAccount(tx, input.accountId);
        const name = nextFreeName(await liveNames(tx, input), input.name);
        const [row] = await tx
          .insert(mcpConnections)
          .values({
            id: input.id,
            accountId: input.accountId,
            projectId: input.projectId,
            name,
            spec: input.spec,
          })
          .returning();
        if (!row) throw new Error("Connection insert returned no row");
        if (input.sealedToken !== null)
          await tx.insert(mcpConnectionTokens).values({
            connectionId: input.id,
            accountId: input.accountId,
            ciphertext: input.sealedToken,
          });
        const [connection] = await hydrate(tx, [row]);
        if (!connection) throw new Error("Connection insert vanished");
        return connection;
      });
    },

    edit(accountId, id, change) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(mcpConnections)
          .set({
            ...(change.spec ? { spec: change.spec, currentPinId: null } : {}),
            settingsVersion: sql`${mcpConnections.settingsVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(mcpConnections.id, id), eq(mcpConnections.accountId, accountId)))
          .returning();
        if (!row) return null;
        if (change.sealedToken === null)
          await tx.delete(mcpConnectionTokens).where(eq(mcpConnectionTokens.connectionId, id));
        else if (change.sealedToken !== undefined)
          await tx
            .insert(mcpConnectionTokens)
            .values({ connectionId: id, accountId, ciphertext: change.sealedToken })
            .onConflictDoUpdate({
              target: [mcpConnectionTokens.connectionId, mcpConnectionTokens.accountId],
              set: { ciphertext: change.sealedToken, updatedAt: new Date() },
            });
        return (await hydrate(tx, [row]))[0] ?? null;
      });
    },

    savePin(connectionId, pin, pinHash) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(mcpPins).values({ connectionId, pin, pinHash }).returning();
        if (!row) throw new Error("Pin insert returned no row");
        await tx
          .update(mcpConnections)
          .set({ currentPinId: row.id, updatedAt: new Date() })
          .where(eq(mcpConnections.id, connectionId));
        return toPin(row);
      });
    },

    setRemoved(accountId, id, at) {
      return db.transaction(async (tx) => {
        await lockAccount(tx, accountId);
        const [row] = await tx
          .select()
          .from(mcpConnections)
          .where(and(eq(mcpConnections.id, id), eq(mcpConnections.accountId, accountId)));
        if (!row) return "missing" as const;
        const name =
          at === null && row.deletedAt !== null
            ? nextFreeName(await liveNames(tx, row), row.name)
            : row.name;
        await tx
          .update(mcpConnections)
          .set({ name, deletedAt: at, updatedAt: new Date() })
          .where(eq(mcpConnections.id, id));
        return "ok" as const;
      });
    },

    async findPin(pinId) {
      const [row] = await db.select().from(mcpPins).where(eq(mcpPins.id, pinId));
      return row ? toPin(row) : null;
    },

    async purgeRemovedBefore(cutoff) {
      const purged = await db
        .delete(mcpConnections)
        .where(lt(mcpConnections.deletedAt, cutoff))
        .returning({ id: mcpConnections.id });
      return purged.length;
    },

    async readSealedToken(connectionId, accountId) {
      const [row] = await db
        .select({ ciphertext: mcpConnectionTokens.ciphertext })
        .from(mcpConnectionTokens)
        .where(
          and(
            eq(mcpConnectionTokens.connectionId, connectionId),
            eq(mcpConnectionTokens.accountId, accountId),
          ),
        );
      return row?.ciphertext ?? null;
    },

    async writeStatus(write) {
      const written = await db
        .update(mcpConnections)
        .set({
          status: write.status,
          statusReason: write.reason,
          statusVersion: write.version,
          statusStartedAt: write.startedAt,
          checkFinishedAt: write.finishedAt,
        })
        .where(
          and(
            eq(mcpConnections.id, write.connectionId),
            eq(mcpConnections.settingsVersion, write.version),
            or(
              sql`${mcpConnections.statusVersion} IS DISTINCT FROM ${write.version}`,
              isNull(mcpConnections.statusStartedAt),
              lt(mcpConnections.statusStartedAt, write.startedAt),
            ),
          ),
        )
        .returning({ id: mcpConnections.id });
      return written.length > 0;
    },

    async markCheckFinished(id, version, at) {
      await db
        .update(mcpConnections)
        .set({ checkFinishedAt: at })
        .where(
          and(
            eq(mcpConnections.id, id),
            eq(mcpConnections.settingsVersion, version),
            or(isNull(mcpConnections.checkFinishedAt), lt(mcpConnections.checkFinishedAt, at)),
          ),
        );
    },
  };
}
