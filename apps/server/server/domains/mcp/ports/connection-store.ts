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
  pin: PinRecord | null;
  tokenSet: boolean;
}

export interface StatusWrite {
  connectionId: McpConnectionId;
  version: number;
  startedAt: Date;
  status: McpConnectionStatus;
  reason: string | null;
  finishedAt: Date;
}

export interface ConnectionStore {
  listLive(
    accountId: UserId,
    projectId: ProjectId | null,
  ): Promise<{ account: StoredConnection[]; project: StoredConnection[] }>;
  find(accountId: UserId, id: McpConnectionId): Promise<StoredConnection | null>;
  add(input: {
    id: McpConnectionId;
    accountId: UserId;
    projectId: ProjectId | null;
    name: string;
    spec: McpConnectionSpec;
    sealedToken: string | null;
  }): Promise<StoredConnection>;
  edit(
    accountId: UserId,
    id: McpConnectionId,
    change: { spec?: McpConnectionSpec; sealedToken?: string | null },
  ): Promise<StoredConnection | null>;
  savePin(connectionId: McpConnectionId, pin: McpPin, pinHash: string): Promise<PinRecord>;
  setRemoved(accountId: UserId, id: McpConnectionId, at: Date | null): Promise<"ok" | "missing">;
  findPin(pinId: McpPinId): Promise<PinRecord | null>;
  purgeRemovedBefore(cutoff: Date): Promise<number>;
  readSealedToken(connectionId: McpConnectionId, accountId: UserId): Promise<string | null>;
  writeStatus(write: StatusWrite): Promise<boolean>;
  markCheckFinished(id: McpConnectionId, version: number, at: Date): Promise<void>;
}
