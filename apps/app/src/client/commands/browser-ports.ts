import type { ChangeChannel, DeliveryLock, Transport } from "@meridian/command-driver";
import { EXPECTED_ACCOUNT_HEADER } from "@meridian/contracts/commands";
import { deserializeTransport } from "@meridian/contracts/protocol";
import { readResponsePayload } from "@/client/api/http-client";
import { meridianApiErrorFromPayload } from "@/client/api/meridian-error";

export function createWebLock(accountId: string): DeliveryLock {
  return {
    acquire: (signal) =>
      new Promise<() => void>((resolve, reject) => {
        navigator.locks
          .request(
            `meridian:commands:${accountId}`,
            { signal },
            () => new Promise<void>((held) => resolve(held)),
          )
          .catch(reject);
      }),
  };
}

export function createBroadcastChannel(accountId: string): ChangeChannel {
  let channel: BroadcastChannel | null = null;
  const listeners = new Set<() => void>();
  const ensure = () => {
    if (channel) return channel;
    channel = new BroadcastChannel(`meridian-commands:${accountId}`);
    channel.onmessage = () => {
      for (const listener of listeners) listener();
    };
    return channel;
  };
  return {
    post: () => ensure().postMessage(null),
    subscribe(listener) {
      ensure();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}

export function createFetchTransport(accountId: string): Transport {
  return async ({ method, path, body }, signal) => {
    const response = await fetch(path, {
      method,
      signal,
      headers: {
        [EXPECTED_ACCOUNT_HEADER]: accountId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await readResponsePayload(response);
    if (!response.ok)
      return {
        status: response.status,
        body: payload,
        code: meridianApiErrorFromPayload(payload, response.status)?.code ?? null,
      };
    return {
      status: response.status,
      body: payload === null ? null : deserializeTransport(payload),
      code: null,
    };
  };
}
