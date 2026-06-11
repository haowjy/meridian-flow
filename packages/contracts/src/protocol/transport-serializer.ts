export type TransportEnvelope<T> = {
  __meridianTransport: true;
  value: T;
};

export function serializeTransport<T>(value: T): TransportEnvelope<T> {
  return { __meridianTransport: true, value };
}

export function deserializeTransport<T>(payload: T | TransportEnvelope<T>): T {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "__meridianTransport" in payload &&
    payload.__meridianTransport === true &&
    "value" in payload
  ) {
    return payload.value as T;
  }
  return payload as T;
}
