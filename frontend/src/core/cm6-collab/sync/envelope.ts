export const enum MeridianEnvelopeType {
  SyncStep1 = 0x00,
  SyncStep2 = 0x01,
  Update = 0x02,
  Awareness = 0x03,
}

export type SyncMessageType = 0 | 1 | 2;

const UUID_FRAME_BYTES = 16;
const ENVELOPE_FRAME_BYTES = 1;
const FRAME_PREFIX_BYTES = ENVELOPE_FRAME_BYTES + UUID_FRAME_BYTES;

export function frameEnvelope(
  envelope: MeridianEnvelopeType,
  documentId: string,
  payload: Uint8Array,
): Uint8Array {
  const documentIdBytes = uuidStringToBytes(documentId);
  const framed = new Uint8Array(FRAME_PREFIX_BYTES + payload.length);
  framed[0] = envelope;
  framed.set(documentIdBytes, ENVELOPE_FRAME_BYTES);
  framed.set(payload, FRAME_PREFIX_BYTES);
  return framed;
}

export function unwrapEnvelope(frame: Uint8Array): {
  envelope: MeridianEnvelopeType | null;
  documentId: string | null;
  payload: Uint8Array;
} {
  if (frame.length < FRAME_PREFIX_BYTES) {
    return {
      envelope: null,
      documentId: null,
      payload: new Uint8Array(0),
    };
  }

  const envelope = frame[0] as MeridianEnvelopeType;
  const documentId = uuidBytesToString(
    frame.subarray(ENVELOPE_FRAME_BYTES, FRAME_PREFIX_BYTES),
  );
  return {
    envelope,
    documentId,
    payload: frame.subarray(FRAME_PREFIX_BYTES),
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

function uuidStringToBytes(uuid: string): Uint8Array {
  const normalized = uuid.trim().toLowerCase();
  const parts = normalized.split("-");
  if (
    parts.length !== 5 ||
    parts[0]!.length !== 8 ||
    parts[1]!.length !== 4 ||
    parts[2]!.length !== 4 ||
    parts[3]!.length !== 4 ||
    parts[4]!.length !== 12
  ) {
    throw new Error(`invalid uuid format: ${uuid}`);
  }

  const hex = parts.join("");
  if (hex.length !== UUID_FRAME_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`invalid uuid format: ${uuid}`);
  }

  const out = new Uint8Array(UUID_FRAME_BYTES);
  for (let i = 0; i < UUID_FRAME_BYTES; i += 1) {
    const offset = i * 2;
    out[i] = Number.parseInt(hex.slice(offset, offset + 2), 16);
  }
  return out;
}

function uuidBytesToString(bytes: Uint8Array): string {
  if (bytes.length !== UUID_FRAME_BYTES) {
    throw new Error(`invalid uuid byte length: ${bytes.length}`);
  }

  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
