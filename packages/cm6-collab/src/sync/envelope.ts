export const enum MeridianEnvelopeType {
  SyncStep1 = 0x00,
  SyncStep2 = 0x01,
  Update = 0x02,
  Awareness = 0x03,
}

export type SyncMessageType = 0 | 1 | 2;

export function frameEnvelope(
  envelope: MeridianEnvelopeType,
  payload: Uint8Array,
): Uint8Array {
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = envelope;
  framed.set(payload, 1);
  return framed;
}

export function unwrapEnvelope(frame: Uint8Array): {
  envelope: MeridianEnvelopeType | null;
  payload: Uint8Array;
} {
  if (frame.length === 0) {
    return { envelope: null, payload: new Uint8Array(0) };
  }

  const envelope = frame[0] as MeridianEnvelopeType;
  return {
    envelope,
    payload: frame.subarray(1),
  };
}

export function envelopeFromSyncType(
  syncType: SyncMessageType,
): MeridianEnvelopeType {
  switch (syncType) {
    case 0:
      return MeridianEnvelopeType.SyncStep1;
    case 1:
      return MeridianEnvelopeType.SyncStep2;
    case 2:
      return MeridianEnvelopeType.Update;
    default:
      return MeridianEnvelopeType.Update;
  }
}
