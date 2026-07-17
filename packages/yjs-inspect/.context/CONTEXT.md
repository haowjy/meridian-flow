# packages/yjs-inspect -- Context

## Contracts

### Egress-only content invariant

The content rule guards *egress*, not transient in-process state. Yjs
decodes item content internally during `Y.decodeUpdate` -- the same path
runs on every product-side `applyUpdate` -- and both observing processes
already hold the document, so the transient decode adds no new exposure.
This scope was settled after S1's `TextDecoder` canary probe confirmed
that `Y.parseUpdateMeta` and `Y.decodeUpdate` both instantiate
`ContentString` objects in-process, falsifying D2's original "without
materializing content" claim.

The canary gate scans recursively: it checks every exported function
crossed with every frame path and rejects non-JSON-natural output shapes
(Uint8Array, Map, Set, Symbol, foreign prototypes) outright. These types
matter because lib0 and yjs containers leak content through them.

### Total observer boundary

`summarizeUpdate` never throws because its S4 consumers (server journal
admission receipts) sit on the product path. A throwing observer turns
instrumentation into a product-path exception. The `InvalidUpdate` arm
carries `{ invalid: true, reason, bytes, updateHash }` so the offending
row stays identifiable without content egress. It is distinct from a valid
no-op (`isNoop: true`) -- a broken row must never masquerade as the D2
no-op correlation class.

`inspectFrame` and `classifyFrame` also never throw; unknown or truncated
input is classified, not rejected.

### Delete-span creator identity

Delete spans key on the *creator* of the deleted items because that is the
only identity the protocol carries. Yjs delete sets record which items are
deleted by `(client, clock, length)`, where `client` is the original
author. The deleter's identity exists only as the transaction origin, which
is not part of the delete set encoding. Probe-verified: client B deleting
client A's text yields a delete span under A's client id.

## Architecture

### Composition

`inspectFrame` is the composed entry point: it calls `classifyFrame` for
envelope parsing, then nests `summarizeUpdate` or `summarizeAwareness`
depending on the classified message type. Taps call `inspectFrame`; they
never parse envelopes themselves. `summarizeUpdate` is also available
standalone for bare updates stored outside wire frames (journal rows).

The outer Hocuspocus frame envelope (document name + message type) is
decoded directly from the lib0 encoding with no Hocuspocus import. The
package depends only on `yjs`, `y-protocols`, and `lib0`, keeping it
liftable out of the monorepo.

### Stateless body handling

lib0 strings and byte arrays share the same length-prefixed envelope
format. Stateless message bodies are read as bytes (`readVarUint8Array`)
rather than strings (`readVarString`) so observer code never materializes
the stateless content.

## Rationale

### Hash as secondary key

`updateHash` (first 16 hex of SHA-256 via `lib0/hash/sha256`) is sync
and browser-safe but is demoted to a secondary exact-byte correlation key
because it breaks when the server merges, re-encodes, or compacts
updates. The measured live path (1 frame -> 1 journal row) preserves
bytes, but that assumption is fragile. Spans survive `Y.mergeUpdates`
(union + adjacent-range coalescing, probe-verified) and are the primary
correlation identity.

### Per-transaction vs cumulative delete sets

`doc.on("update")` (the wire path Hocuspocus forwards) emits
per-transaction delete sets: a deletion-only keystroke carries exactly its
own delete spans. `Y.encodeStateAsUpdate(doc, sv)` (sync-step-2) carries
the cumulative delete set, fanning in to many client entries by design.
Consumers downstream (S3/S4) must distinguish these paths when correlating.
