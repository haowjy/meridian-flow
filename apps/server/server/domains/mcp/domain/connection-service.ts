/**
 * The writer's connections: add, edit, choose tools, remove and undo, and the one level
 * resolution the bake and the settings list share. Status is `connection-checks.ts`.
 */

import { randomUUID } from "node:crypto";
import type { ProjectId, UserId } from "@meridian/contracts";
import {
  isMcpConnectionName,
  type McpConnectionId,
  type McpConnectionStatus,
  type McpConnectionView,
  type McpToolView,
} from "@meridian/contracts/mcp";
import {
  type Listing,
  type McpClient,
  pin as makePin,
  pinHash,
  type Server,
} from "@meridian-flow/runtime/mcp";
import type {
  ConnectionRow,
  ConnectionStore,
  StoredConnection,
} from "../ports/connection-store.js";
import { createConnectionChecks } from "./connection-checks.js";
import { type Resolved, resolveByName } from "./resolve-connections.js";
import type { TokenCipher } from "./token-cipher.js";

/** A refusal the settings API words for the writer; `code` picks the HTTP status. */
export class McpConnectionError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "not_listed" | "not_read_only",
    message: string,
  ) {
    super(message);
    this.name = "McpConnectionError";
  }
}

export interface McpConnectionsDeps {
  store: ConnectionStore;
  client: McpClient;
  cipher: TokenCipher;
  /** Why Flow will never contact this address, or null: an address like that is a typo, so add and edit refuse it at once. */
  addressRefusal(url: URL): string | null;
  /** The sessions key: account, connection and settings version. */
  sessionKey(row: ConnectionRow): string;
  statusChanged(row: ConnectionRow): void;
  failed(cause: unknown, row: ConnectionRow): void;
  now?: () => Date;
}

const LIST_TIMEOUT_MS = 15_000;
/** A removed connection stays for Undo this long; then it goes with its token and pins. */
export const REMOVED_RETENTION_MS = 30 * 24 * 60 * 60_000;

const isReadOnly = (tool: { annotations?: unknown }): boolean => {
  const { annotations } = tool as { annotations?: { readOnlyHint?: unknown } };
  return annotations?.readOnlyHint === true;
};

function toolViews(
  tools: readonly { name: string; listed: Record<string, unknown> }[],
): McpToolView[] {
  return tools.map(({ name, listed }) => ({
    name,
    description: typeof listed.description === "string" ? listed.description : "",
    readOnly: isReadOnly(listed),
  }));
}

export function createMcpConnections(deps: McpConnectionsDeps) {
  function parseUrl(raw: unknown): string {
    if (typeof raw !== "string") throw new McpConnectionError("invalid", "Invalid address");
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new McpConnectionError("invalid", "Invalid address");
    }
    if (deps.addressRefusal(url)) {
      const problem = mcpAddressProblem(url);
      throw new McpConnectionError(
        "invalid",
        problem === "not_https"
          ? "Needs an https address"
          : problem === "not_port_443"
            ? "Needs port 443"
            : "Invalid address",
      );
    }
    url.hash = "";
    return url.toString();
  }

  const now = deps.now ?? (() => new Date());
  const checks = createConnectionChecks({
    store: deps.store,
    client: deps.client,
    statusChanged: deps.statusChanged,
    failed: deps.failed,
    now,
    async loadServer(row) {
      return serverFor(row);
    },
  });

  async function serverFor(
    row: ConnectionRow,
  ): Promise<{ server: Server } | { problem: "unreadable_token" }> {
    const sealed = await deps.store.readSealedToken(row.id, row.accountId);
    let token: string | undefined;
    if (sealed !== null) {
      try {
        token = deps.cipher.open(sealed, { connectionId: row.id, accountId: row.accountId });
      } catch {
        return { problem: "unreadable_token" };
      }
    }
    return {
      server: {
        key: deps.sessionKey(row),
        spec: {
          transport: "http",
          url: row.spec.url,
          ...(token !== undefined ? { auth: { token: async () => token } } : {}),
        },
      },
    };
  }

  function view(stored: StoredConnection, shadowedBy: McpConnectionId | null): McpConnectionView {
    const { row, pin } = stored;
    const known = row.statusVersion === row.settingsVersion;
    const status: McpConnectionStatus | null = known ? row.status : null;
    return {
      id: row.id,
      level: row.projectId ? "project" : "account",
      projectId: row.projectId,
      name: row.name,
      url: row.spec.url,
      tokenSet: stored.tokenSet,
      status,
      statusReason: known ? row.statusReason : null,
      checkedAt: known && row.checkFinishedAt ? row.checkFinishedAt.toISOString() : null,
      pin: pin
        ? {
            id: pin.id,
            pinnedAt: pin.pin.pinnedAt,
            server: { name: pin.pin.server.name, version: pin.pin.server.version },
            tools: toolViews(pin.pin.tools),
          }
        : null,
      shadowedBy,
    };
  }

  async function owned(accountId: UserId, id: McpConnectionId): Promise<StoredConnection> {
    const stored = await deps.store.find(accountId, id);
    if (!stored || stored.row.deletedAt)
      throw new McpConnectionError("not_found", "Connection not found.");
    return stored;
  }

  /** The one place the account's and the project's connections are put in order and shadowed. */
  async function resolve(
    accountId: UserId,
    projectId: ProjectId | null,
  ): Promise<Resolved<StoredConnection>[]> {
    const levels = await deps.store.listLive(accountId, projectId);
    return resolveByName(levels, ({ row }) => row);
  }

  /** Lists a server's tools. A server that does not answer is a status, not an error. */
  async function listTools(stored: StoredConnection): Promise<McpToolView[] | null> {
    const listing = await listingOf(stored);
    return listing
      ? toolViews(listing.tools.map((tool) => ({ name: String(tool.name), listed: tool })))
      : null;
  }

  /** The server's listing, or null when it gave none: a check then decides what that means. */
  async function listingOf(stored: StoredConnection): Promise<Listing | null> {
    const loaded = await serverFor(stored.row);
    if ("problem" in loaded) return null;
    const outcome = await deps.client.list(loaded.server, { timeoutMs: LIST_TIMEOUT_MS });
    if ("tools" in outcome) return outcome;
    if (outcome.kind !== "aborted")
      void checks.check(stored.row).catch((cause) => deps.failed(cause, stored.row));
    return null;
  }

  const chosenTools = (stored: StoredConnection) =>
    stored.pin?.pin.tools.map((tool) => tool.name) ?? [];

  /**
   * After an address edit: pins what the new server lists of the tools the writer had chosen
   * (read-only ones only, as `pin` requires). A server that cannot be listed leaves the connection
   * with no pin, and the screen offers Choose tools.
   */
  async function repin(after: StoredConnection, chosen: readonly string[]): Promise<void> {
    if (chosen.length === 0) return;
    const listing = await listingOf(after);
    if (!listing) return;
    const names = chosen.filter((name) =>
      listing.tools.some((tool) => String(tool.name) === name && isReadOnly(tool)),
    );
    if (names.length === 0) return;
    const made = makePin(listing, { tools: names, pinnedAt: now().toISOString() });
    if ("problems" in made) return;
    // Another edit while the server was listing: its own re-pin follows, this listing is of an old address.
    const current = await deps.store.find(after.row.accountId, after.row.id);
    if (
      !current ||
      current.row.deletedAt ||
      current.row.settingsVersion !== after.row.settingsVersion
    )
      return;
    await deps.store.savePin(after.row.id, made.pin, pinHash(made.pin));
    deps.statusChanged(after.row);
  }

  return {
    resolve,
    checks,
    serverFor,

    async list(accountId: UserId, projectId: ProjectId | null): Promise<McpConnectionView[]> {
      const resolved = await resolve(accountId, projectId);
      checks.startDue(resolved.map((entry) => entry.item.row));
      return resolved.map((entry) => view(entry.item, entry.shadowedBy));
    },

    async add(
      accountId: UserId,
      input: { name: string; url: string; token?: string; projectId?: ProjectId },
    ): Promise<{ connection: McpConnectionView; tools: McpToolView[] | null }> {
      if (!isMcpConnectionName(input.name))
        throw new McpConnectionError("invalid", "Invalid name");
      const url = parseUrl(input.url);
      const id = randomUUID();
      const token = input.token?.trim();
      const added = await deps.store.add({
        id,
        accountId,
        projectId: input.projectId ?? null,
        name: input.name,
        spec: { transport: "http", url },
        sealedToken: token ? deps.cipher.seal(token, { connectionId: id, accountId }) : null,
      });
      // The listing is the first contact: an answer shows the tools, none leaves the connection
      // saved with no pin, and the check that follows says why.
      const startedAt = now();
      const tools = await listTools(added);
      if (tools === null) await checks.check(added.row);
      else
        await deps.store.writeStatus({
          connectionId: id,
          version: 1,
          startedAt,
          status: "connected",
          reason: null,
          finishedAt: now(),
        });
      const fresh = (await deps.store.find(accountId, id)) ?? added;
      return { connection: view(fresh, null), tools };
    },

    async edit(
      accountId: UserId,
      id: McpConnectionId,
      change: { url?: string; token?: string },
    ): Promise<McpConnectionView> {
      const before = await owned(accountId, id);
      const url = change.url !== undefined ? parseUrl(change.url) : undefined;
      const spec =
        url !== undefined && url !== before.row.spec.url
          ? { transport: "http" as const, url }
          : undefined;
      const token = change.token?.trim();
      const sealedToken =
        change.token === undefined
          ? undefined
          : token
            ? deps.cipher.seal(token, { connectionId: id, accountId })
            : null;
      if (spec === undefined && sealedToken === undefined) return view(before, null);
      const after = await deps.store.edit(accountId, id, { spec, sealedToken });
      if (!after) throw new McpConnectionError("not_found", "Connection not found.");
      // The old session is of the old address or token; every other process moves on by key.
      void deps.client.close(deps.sessionKey(before.row));
      // A new version has no result; the check that learns one runs in the background.
      deps.statusChanged(after.row);
      void checks.check(after.row).catch((cause) => deps.failed(cause, after.row));
      if (spec)
        void repin(after, chosenTools(before)).catch((cause) => deps.failed(cause, after.row));
      return view(after, null);
    },

    async tools(accountId: UserId, id: McpConnectionId) {
      const stored = await owned(accountId, id);
      const tools = await listTools(stored);
      const fresh = (await deps.store.find(accountId, id)) ?? stored;
      return { connection: view(fresh, null), tools };
    },

    /** Keeps the chosen tools exactly as the server lists them now. Read-only tools only until the owner decides how calls with effects are held. */
    async pin(
      accountId: UserId,
      id: McpConnectionId,
      toolNames: string[],
    ): Promise<McpConnectionView> {
      const stored = await owned(accountId, id);
      const listing = await listingOf(stored);
      if (!listing) throw new McpConnectionError("not_listed", "Couldn't list tools");
      const effects = listing.tools.filter(
        (tool) => toolNames.includes(String(tool.name)) && !isReadOnly(tool),
      );
      if (effects.length > 0)
        throw new McpConnectionError(
          "not_read_only",
          `Read-only tools only: ${effects.map((tool) => String(tool.name)).join(", ")}.`,
        );
      const made = makePin(listing, { tools: toolNames, pinnedAt: now().toISOString() });
      if ("problems" in made)
        throw new McpConnectionError(
          "invalid",
          made.problems.map((problem) => problem.message).join(" "),
        );
      await deps.store.savePin(id, made.pin, pinHash(made.pin));
      deps.statusChanged(stored.row);
      return view((await deps.store.find(accountId, id)) ?? stored, null);
    },

    async remove(accountId: UserId, id: McpConnectionId): Promise<void> {
      const stored = await owned(accountId, id);
      await deps.store.setRemoved(accountId, id, now());
      void deps.client.close(deps.sessionKey(stored.row));
      deps.statusChanged(stored.row);
    },

    async undo(accountId: UserId, id: McpConnectionId): Promise<McpConnectionView> {
      const stored = await deps.store.find(accountId, id);
      if (!stored) throw new McpConnectionError("not_found", "Connection not found.");
      await deps.store.setRemoved(accountId, id, null);
      deps.statusChanged(stored.row);
      const fresh = (await deps.store.find(accountId, id)) ?? stored;
      checks.startDue([fresh.row]);
      return view(fresh, null);
    },

    /** Deletes the connections removed more than 30 days ago, so a writer's third-party credential never lingers. */
    async purgeRemoved(): Promise<number> {
      return deps.store.purgeRemovedBefore(new Date(now().getTime() - REMOVED_RETENTION_MS));
    },

    /** Try again: a check now, whatever the last one's age, and its result. */
    async tryAgain(accountId: UserId, id: McpConnectionId): Promise<McpConnectionView> {
      const stored = await owned(accountId, id);
      await checks.check(stored.row);
      return view((await deps.store.find(accountId, id)) ?? stored, null);
    },
  };
}

export type McpConnections = ReturnType<typeof createMcpConnections>;
