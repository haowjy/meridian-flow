/** Persistence for MCP connections, their pins and their tokens. Every method is scoped to the account. */
import type { ProjectId, UserId } from "@meridian/contracts";
import type {
  McpConnectionId,
  McpConnectionSpec,
  McpConnectionStatus,
  McpPin,
  McpPinId,
} from "@meridian/contracts/mcp";

export interface ConnectionRow {
  id: McpConnectionId;
  accountId: UserId;
  /** Null for an account connection. */
  projectId: ProjectId | null;
  name: string;
  spec: McpConnectionSpec;
  currentPinId: McpPinId | null;
  settingsVersion: number;
  status: McpConnectionStatus | null;
  statusReason: string | null;
  statusVersion: number | null;
  statusStartedAt: Date | null;
  checkFinishedAt: Date | null;
  deletedAt: Date | null;
}

export interface PinRecord {
  id: McpPinId;
  connectionId: McpConnectionId;
  pin: McpPin;
  createdAt: Date;
}

export interface StoredConnection {
  row: ConnectionRow;
  /** The current pin. */
  pin: PinRecord | null;
  tokenSet: boolean;
}

export interface StatusWrite {
  connectionId: McpConnectionId;
  /** The settings version the check or call ran under. */
  version: number;
  /** When it started: a result is kept only if it started after the stored one. */
  startedAt: Date;
  status: McpConnectionStatus;
  reason: string | null;
  finishedAt: Date;
}

export interface ConnectionStore {
  /** Live connections of the account, and of the project when one is named. */
  listLive(
    accountId: UserId,
    projectId: ProjectId | null,
  ): Promise<{ account: StoredConnection[]; project: StoredConnection[] }>;
  /** Removed connections included: undo needs them. */
  find(accountId: UserId, id: McpConnectionId): Promise<StoredConnection | null>;
  /** Saves the connection under its name, or under the next free `<name>-2`, `-3`… when the level already has it. */
  add(input: {
    id: McpConnectionId;
    accountId: UserId;
    projectId: ProjectId | null;
    name: string;
    spec: McpConnectionSpec;
    sealedToken: string | null;
  }): Promise<StoredConnection>;
  /** Bumps the settings version. A new `spec` drops the current pin: it listed another server. `sealedToken`: a string replaces the token, null clears it, undefined leaves it. */
  edit(
    accountId: UserId,
    id: McpConnectionId,
    change: { spec?: McpConnectionSpec; sealedToken?: string | null },
  ): Promise<StoredConnection | null>;
  /** Inserts the pin and makes it the connection's current one. */
  savePin(connectionId: McpConnectionId, pin: McpPin, pinHash: string): Promise<PinRecord>;
  /** Null restores, under the next free name when the level has taken it since. */
  setRemoved(accountId: UserId, id: McpConnectionId, at: Date | null): Promise<"ok" | "missing">;
  /** A pin by id, whether or not it is still its connection's current one. */
  findPin(pinId: McpPinId): Promise<PinRecord | null>;
  /** Deletes connections removed before `cutoff`, with their pins and tokens; returns how many. */
  purgeRemovedBefore(cutoff: Date): Promise<number>;
  readSealedToken(connectionId: McpConnectionId, accountId: UserId): Promise<string | null>;
  /**
   * Stores a status only for the current settings version and only if it started after the
   * stored one. Returns whether it was stored.
   */
  writeStatus(write: StatusWrite): Promise<boolean>;
  /** Records that a check of this version ended, whether or not its status was kept. */
  markCheckFinished(id: McpConnectionId, version: number, at: Date): Promise<void>;
}
