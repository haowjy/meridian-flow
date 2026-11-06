/** Immutable attempt settlement around the existing result-aware namespace owner. */
import { isDeepStrictEqual } from "node:util";
import type {
  ContextDestinationParent,
  ContextEntryRef,
  ContextOperationCommand,
  ContextOperationReceipt,
  ContextOperationResult,
  ContextSiblingPosition,
} from "@meridian/contracts/protocol";
import type { ContextOperationReceiptStore } from "../ports/context-operation-receipts.js";

class RejectedOperation<K extends ContextOperationCommand["kind"]> extends Error {
  constructor(readonly result: Extract<ContextOperationResult<K>, { ok: false }>) {
    super("Context namespace attempt rejected");
  }
}

/**
 * What a move was asked to do, as its receipt records it: a function of the request alone, so a
 * resend matches however the row has moved since. The route builds it once, for both the resend
 * lookup and the mover.
 */
export function moveCommand(request: {
  expected: ContextEntryRef;
  destinationParent?: ContextDestinationParent;
  position?: ContextSiblingPosition;
  name?: string;
}): Extract<ContextOperationCommand, { kind: "move" }> {
  const { expected, destinationParent, position, name } = request;
  return {
    kind: "move",
    expected,
    ...(destinationParent ? { destinationParent } : {}),
    ...(position ? { position } : {}),
    ...(name ? { name } : {}),
  };
}

export function deleteCommand(request: {
  expected: ContextEntryRef;
}): Extract<ContextOperationCommand, { kind: "delete" }> {
  return { kind: "delete", expected: request.expected };
}

/**
 * Where a settled operation changed things: the address the observation version is read for. A
 * refusal names it in its error; a Copy's command names its destination.
 */
function resultAddress(
  command: ContextOperationCommand,
  result: ContextOperationResult<ContextOperationCommand["kind"]>,
): string {
  if (!result.ok) return result.error.uri;
  if (command.kind === "copy") return command.destinationUri;
  return "destinationUri" in result.value
    ? result.value.destinationUri
    : (result.value as { uri: string }).uri;
}

export class ContextOperationReceipts {
  constructor(private readonly store: ContextOperationReceiptStore) {}

  lookup(operationId: string): Promise<ContextOperationReceipt | null> {
    return this.store.lookup(operationId);
  }

  /** `address` is where the command was aimed, which an `operation_mismatch` names. */
  execute<K extends ContextOperationCommand["kind"]>(
    operationId: string,
    command: Extract<ContextOperationCommand, { kind: K }>,
    address: string,
    operation: () => Promise<ContextOperationResult<K>>,
  ): Promise<ContextOperationResult<K>> {
    return this.store.transaction(operationId, async () => {
      const previous = await this.store.lookup(operationId);
      if (previous) {
        if (!isDeepStrictEqual(previous.command, command))
          return {
            ok: false,
            error: {
              code: "operation_mismatch",
              uri: address,
            },
          };
        return previous.result as ContextOperationResult<K>;
      }
      let result: ContextOperationResult<K>;
      try {
        result = await this.store.savepoint(async () => {
          const result = await operation();
          // An inner Result-aware owner may have caught its rollback exception.
          // Roll back this real savepoint before recording a definite rejection.
          if (!result.ok) throw new RejectedOperation(result);
          return result;
        });
      } catch (error) {
        if (!(error instanceof RejectedOperation)) throw error;
        result = error.result;
      }
      if (!result.ok && result.error.code === "io_error") return result;
      await this.store.insert({
        operationId,
        command,
        result,
        observationVersion: await this.store.observationVersion(resultAddress(command, result)),
      } as ContextOperationReceipt);
      return result;
    });
  }
}
