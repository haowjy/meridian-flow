/** QueryClient-scoped semantic ownership for visible-chat open acknowledgements. */
import type { UpdateThreadUserStateResponse } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { runThreadUserStateCommand } from "./thread-user-state-commands";

declare const openId: unique symbol;
export type OpenAcknowledgementOperationId = string & { readonly [openId]: true };
declare const leaseId: unique symbol;
export type VisibilityLeaseId = string & { readonly [leaseId]: true };

export type OpenAcknowledgementKey = Readonly<{ projectId: string; threadId: string }>;
export type OpenAcknowledgementState =
  | { phase: "pending"; id: OpenAcknowledgementOperationId; attempt: number }
  | {
      phase: "failed";
      id: OpenAcknowledgementOperationId;
      attempt: number;
      error: Error;
    }
  | {
      phase: "succeeded";
      id: OpenAcknowledgementOperationId;
      attempt: number;
      response: UpdateThreadUserStateResponse;
    };
export type OpenAcknowledgementTransfer = Readonly<{
  id: OpenAcknowledgementOperationId;
  key: OpenAcknowledgementKey;
}>;
export type HomeOpenOffer =
  | Readonly<{ kind: "active"; operationId: OpenAcknowledgementOperationId }>
  | Readonly<{ kind: "transfer"; transfer: OpenAcknowledgementTransfer }>;

type Operation = {
  key: OpenAcknowledgementKey;
  state: OpenAcknowledgementState;
  transfer: OpenAcknowledgementTransfer | null;
  leases: Set<VisibilityLeaseId>;
  listeners: Set<() => void>;
};
type Lease = { operationId: OpenAcknowledgementOperationId; generation: number };
type Coordinator = {
  nextId: number;
  nextLeaseGeneration: number;
  operations: Map<OpenAcknowledgementOperationId, Operation>;
  leases: Map<VisibilityLeaseId, Lease>;
};

const coordinators = new WeakMap<QueryClient, Coordinator>();
const sameKey = (left: OpenAcknowledgementKey, right: OpenAcknowledgementKey) =>
  left.projectId === right.projectId && left.threadId === right.threadId;

function coordinator(client: QueryClient): Coordinator {
  let owner = coordinators.get(client);
  if (!owner) {
    owner = { nextId: 0, nextLeaseGeneration: 0, operations: new Map(), leases: new Map() };
    coordinators.set(client, owner);
  }
  return owner;
}

function nextLeaseGeneration(owner: Coordinator) {
  owner.nextLeaseGeneration += 1;
  return owner.nextLeaseGeneration;
}

function newId(owner: Coordinator): OpenAcknowledgementOperationId {
  owner.nextId += 1;
  return `open-${owner.nextId}` as OpenAcknowledgementOperationId;
}

export function createVisibilityLeaseId(): VisibilityLeaseId {
  return crypto.randomUUID() as VisibilityLeaseId;
}

function publish(operation: Operation) {
  operation.listeners.forEach((listener) => {
    listener();
  });
}

function retireIfUnowned(owner: Coordinator, id: OpenAcknowledgementOperationId) {
  const operation = owner.operations.get(id);
  if (!operation || operation.transfer || operation.leases.size > 0) return;
  if (operation.state.phase !== "pending") owner.operations.delete(id);
}

function beginOperation(
  client: QueryClient,
  key: OpenAcknowledgementKey,
): [OpenAcknowledgementOperationId, Operation] {
  const owner = coordinator(client);
  const id = newId(owner);
  const operation: Operation = {
    key,
    state: { phase: "pending", id, attempt: 1 },
    transfer: null,
    leases: new Set(),
    listeners: new Set(),
  };
  owner.operations.set(id, operation);
  runAttempt(client, id, operation, 1);
  return [id, operation];
}

function runAttempt(
  client: QueryClient,
  id: OpenAcknowledgementOperationId,
  operation: Operation,
  attempt: number,
) {
  void runThreadUserStateCommand(
    client,
    operation.key.projectId,
    operation.key.threadId,
    "isUnread",
    false,
  ).then((outcome) => {
    const owner = coordinator(client);
    if (owner.operations.get(id) !== operation || operation.state.attempt !== attempt) return;
    operation.state =
      outcome.status === "success"
        ? { phase: "succeeded", id, attempt, response: outcome.response }
        : { phase: "failed", id, attempt, error: outcome.error };
    publish(operation);
    retireIfUnowned(owner, id);
  });
}

export function prepareHomeOpenAcknowledgement(
  client: QueryClient,
  key: OpenAcknowledgementKey,
): HomeOpenOffer {
  const owner = coordinator(client);
  for (const [id, operation] of owner.operations) {
    if (operation.leases.size > 0 && sameKey(operation.key, key)) {
      return { kind: "active", operationId: id };
    }
  }
  const [id, operation] = beginOperation(client, key);
  const transfer: OpenAcknowledgementTransfer = { id, key };
  operation.transfer = transfer;
  return { kind: "transfer", transfer };
}

function detachLease(owner: Coordinator, leaseId: VisibilityLeaseId) {
  const lease = owner.leases.get(leaseId);
  if (!lease) return;
  owner.leases.delete(leaseId);
  const operation = owner.operations.get(lease.operationId);
  operation?.leases.delete(leaseId);
  retireIfUnowned(owner, lease.operationId);
}

export function claimVisibleOpenAcknowledgement(
  client: QueryClient,
  key: OpenAcknowledgementKey,
  leaseId: VisibilityLeaseId,
  transfer?: OpenAcknowledgementTransfer,
): OpenAcknowledgementOperationId {
  const owner = coordinator(client);
  const existingLease = owner.leases.get(leaseId);
  const existingOperation = existingLease
    ? owner.operations.get(existingLease.operationId)
    : undefined;
  if (existingLease && existingOperation && sameKey(existingOperation.key, key)) {
    existingLease.generation = nextLeaseGeneration(owner);
    return existingLease.operationId;
  }
  if (existingLease) detachLease(owner, leaseId);

  for (const [id, operation] of owner.operations) {
    if (operation.leases.size > 0 && sameKey(operation.key, key)) {
      operation.leases.add(leaseId);
      owner.leases.set(leaseId, { operationId: id, generation: nextLeaseGeneration(owner) });
      return id;
    }
  }

  let id: OpenAcknowledgementOperationId;
  let operation: Operation;
  const transferred = transfer ? owner.operations.get(transfer.id) : undefined;
  if (
    transfer &&
    transferred?.transfer === transfer &&
    sameKey(transfer.key, key) &&
    sameKey(transferred.key, key)
  ) {
    id = transfer.id;
    operation = transferred;
    operation.transfer = null;
  } else {
    if (transfer) cancelOpenAcknowledgementTransfer(client, transfer);
    [id, operation] = beginOperation(client, key);
  }
  operation.leases.add(leaseId);
  owner.leases.set(leaseId, { operationId: id, generation: nextLeaseGeneration(owner) });
  return id;
}

export function cancelOpenAcknowledgementTransfer(
  client: QueryClient,
  transfer: OpenAcknowledgementTransfer,
) {
  const owner = coordinator(client);
  const operation = owner.operations.get(transfer.id);
  if (!operation || operation.transfer !== transfer) return;
  operation.transfer = null;
  retireIfUnowned(owner, transfer.id);
}

export function releaseVisibleOpenAcknowledgement(client: QueryClient, leaseId: VisibilityLeaseId) {
  const owner = coordinator(client);
  const lease = owner.leases.get(leaseId);
  if (!lease) return;
  const generation = lease.generation;
  queueMicrotask(() => {
    const current = owner.leases.get(leaseId);
    if (!current || current.generation !== generation) return;
    detachLease(owner, leaseId);
  });
}

export function retryOpenAcknowledgement(client: QueryClient, id: OpenAcknowledgementOperationId) {
  const operation = coordinator(client).operations.get(id);
  if (operation?.state.phase !== "failed") return;
  const attempt = operation.state.attempt + 1;
  operation.state = { phase: "pending", id, attempt };
  publish(operation);
  runAttempt(client, id, operation, attempt);
}

export function getOpenAcknowledgementState(
  client: QueryClient,
  id: OpenAcknowledgementOperationId,
): OpenAcknowledgementState | null {
  return coordinator(client).operations.get(id)?.state ?? null;
}

export function subscribeOpenAcknowledgement(
  client: QueryClient,
  id: OpenAcknowledgementOperationId,
  listener: () => void,
) {
  const operation = coordinator(client).operations.get(id);
  if (!operation) return () => undefined;
  operation.listeners.add(listener);
  return () => operation.listeners.delete(listener);
}
