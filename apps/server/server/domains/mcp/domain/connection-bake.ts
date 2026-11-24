import type { ProjectId, UserId } from "@meridian/contracts";
import type { McpBakedConnection, McpBakedListing } from "@meridian/contracts/mcp";
import { type Pin, toCatalogue } from "@meridian-flow/runtime/mcp";
import type { ConnectionRow, ConnectionStore } from "../ports/connection-store.js";
import type { McpConnections } from "./connection-service.js";
import { winners } from "./resolve-connections.js";

export const BY_NAME_WINDOW_MS = 2 * 60_000;

export interface ConnectionBake {
  bakedConnections: McpBakedConnection[];
  catalogue: string | null;
}

export const NO_CONNECTIONS: ConnectionBake = { bakedConnections: [], catalogue: null };

const HEADER =
  "Connections (not loaded). Before the first call to one of these tools, call mcp_describe with its name to read its arguments. Then call it with mcp_call.";

const WHY = {
  unreachable: "could not be reached",
  needs_sign_in: "needs the writer to sign in again",
} as const;

export const toolId = (connection: string, tool: string) => `${connection}/${tool}`;

function listingOf(row: ConnectionRow | null, now: Date): McpBakedListing {
  if (!row || row.statusVersion !== row.settingsVersion) return { listing: "full" };
  if (row.status === "needs_sign_in") return { listing: "by_name", reason: "needs_sign_in" };
  if (
    row.status === "unreachable" &&
    row.statusStartedAt &&
    now.getTime() - row.statusStartedAt.getTime() <= BY_NAME_WINDOW_MS
  )
    return { listing: "by_name", reason: "unreachable" };
  return { listing: "full" };
}

function catalogueOf(entries: readonly { baked: McpBakedConnection; pin: Pin }[]): string | null {
  if (entries.length === 0) return null;
  const full = entries.flatMap(({ baked, pin }) =>
    baked.listing === "full"
      ? pin.tools.map((tool) => ({ id: toolId(baked.name, tool.name), tool }))
      : [],
  );
  const byName = entries.flatMap(({ baked }) =>
    baked.listing === "by_name"
      ? [
          `${baked.name}: ${WHY[baked.reason]}. Do not use it unless you are asked to; then call mcp_describe with "${baked.name}" to list its tools, and try one.`,
        ]
      : [],
  );
  return [
    HEADER,
    ...(full.length ? [toCatalogue(full)] : []),
    ...(byName.length ? ["Not working when this was written:", byName.join("\n")] : []),
  ].join("\n\n");
}

export const connectionCatalogue = (name: string, pin: Pin): string =>
  toCatalogue(pin.tools.map((tool) => ({ id: toolId(name, tool.name), tool })));

export interface ConnectionBakeDeps {
  service: Pick<McpConnections, "resolve" | "checks">;
  store: Pick<ConnectionStore, "find" | "findPin">;
  now?: () => Date;
}

export function createConnectionBake(deps: ConnectionBakeDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async forWriter(accountId: UserId, projectId: ProjectId | null): Promise<ConnectionBake> {
      const held = winners(await deps.service.resolve(accountId, projectId)).flatMap(({ item }) =>
        item.pin ? [{ row: item.row, pin: item.pin }] : [],
      );
      const at = now();
      const entries = held.map(({ row, pin }) => ({
        baked: {
          name: row.name,
          connectionId: row.id,
          pinId: pin.id,
          ...listingOf(row, at),
        },
        pin: pin.pin,
      }));
      return {
        bakedConnections: entries.map((entry) => entry.baked),
        catalogue: catalogueOf(entries),
      };
    },

    async fromHeld(
      accountId: UserId,
      held: readonly McpBakedConnection[],
    ): Promise<ConnectionBake> {
      const at = now();
      const entries = (
        await Promise.all(
          held.map(async (connection) => {
            const [pin, stored] = await Promise.all([
              deps.store.findPin(connection.pinId),
              deps.store.find(accountId, connection.connectionId),
            ]);
            if (!pin) return [];
            return [
              {
                baked: {
                  name: connection.name,
                  connectionId: connection.connectionId,
                  pinId: connection.pinId,
                  ...listingOf(stored?.row.deletedAt ? null : (stored?.row ?? null), at),
                },
                pin: pin.pin,
              },
            ];
          }),
        )
      ).flat();
      return {
        bakedConnections: entries.map((entry) => entry.baked),
        catalogue: catalogueOf(entries),
      };
    },

    async saved(accountId: UserId, baked: readonly McpBakedConnection[]): Promise<void> {
      const rows = await Promise.all(
        baked.map(({ connectionId }) => deps.store.find(accountId, connectionId)),
      );
      deps.service.checks.startDue(rows.flatMap((stored) => (stored ? [stored.row] : [])));
    },
  };
}

export type ConnectionBaker = ReturnType<typeof createConnectionBake>;
