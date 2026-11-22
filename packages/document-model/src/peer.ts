import { PEER_ID_LIMIT, SERVER_PEER_LIMIT } from "@meridian/contracts/protocol";
import type { PeerID } from "loro-crdt";

/**
 * Peer ids (design §4). Every writer takes a fresh one: each client session per room, the server's
 * own writer, and every AI turn and command. Loro 1.18 throws on a pending update that names the
 * importing doc's own peer at its next counter, so two writers never share one. A copy uses its
 * one peer across all of its docs.
 *
 * The server's writers take ids below `SERVER_PEER_LIMIT` and clients take ids at or above it, so
 * a reader can tell the server's own ops from a client's by the id alone (on `main`, the "client
 * id below 1,000" rule of the tree list). The limits live in `@meridian/contracts/protocol`, which
 * refuses a Join whose peer is outside the client range.
 */

export type PeerId = PeerID;

function randomBelow(limit: bigint, crypto: Crypto): bigint {
  const words = new BigUint64Array(1);
  crypto.getRandomValues(words);
  return words[0] % limit;
}

/** A fresh peer id for a client session (a browser tab's copy of a room). */
export function freshPeerId(crypto: Crypto = globalThis.crypto): PeerId {
  const peer = SERVER_PEER_LIMIT + randomBelow(PEER_ID_LIMIT - SERVER_PEER_LIMIT, crypto);
  return peer.toString() as PeerId;
}

/** A fresh peer id for one of the server's writers: a room's own, a command's, an AI turn's. */
export function freshServerPeerId(crypto: Crypto = globalThis.crypto): PeerId {
  return (1n + randomBelow(SERVER_PEER_LIMIT - 1n, crypto)).toString() as PeerId;
}

export function isServerPeer(peer: PeerId | bigint): boolean {
  return BigInt(peer) < SERVER_PEER_LIMIT;
}
