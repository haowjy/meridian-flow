export const DEFAULT_HASH_LENGTH = 4;
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const HEX_FIELD_WIDTH = 16;

export function fullHashForBlockId(id: string): string {
  return `${fnv1a64Hex(id)}${fnv1a64Hex(`${id}\u0000`)}`;
}

export function uniqueHashPrefixes(fullHashes: readonly string[]): string[] {
  if (fullHashes.length === 0) return [];
  const byFullHash = fullHashes
    .map((fullHash, i) => ({ i, fullHash }))
    .sort((a, b) => (a.fullHash < b.fullHash ? -1 : a.fullHash > b.fullHash ? 1 : 0));

  const hashes: string[] = new Array(fullHashes.length);
  for (let sortedIndex = 0; sortedIndex < byFullHash.length; sortedIndex += 1) {
    const current = byFullHash[sortedIndex];
    const previous = byFullHash[sortedIndex - 1];
    const next = byFullHash[sortedIndex + 1];
    const lcp = Math.max(
      previous ? commonPrefixLen(current.fullHash, previous.fullHash) : 0,
      next ? commonPrefixLen(current.fullHash, next.fullHash) : 0,
    );
    const length = Math.min(current.fullHash.length, Math.max(DEFAULT_HASH_LENGTH, lcp + 1));
    hashes[current.i] = current.fullHash.slice(0, length);
  }
  return hashes;
}

function commonPrefixLen(first: string, second: string): number {
  let length = 0;
  while (length < first.length && first[length] === second[length]) length += 1;
  return length;
}

function fnv1a64Hex(input: string): string {
  let hash = FNV_64_OFFSET;
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }
  hash ^= hash >> 33n;
  hash = BigInt.asUintN(64, hash * 0xff51afd7ed558ccdn);
  hash ^= hash >> 33n;
  hash = BigInt.asUintN(64, hash * 0xc4ceb9fe1a85ec53n);
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(HEX_FIELD_WIDTH, "0");
}
