# @meridian/contracts

Shared wire contracts: IDs, DTOs, protocols, thread events, context URIs and
document links. This package defines boundary vocabulary; it owns no server
adapters, storage, React or provider behavior.

- `RunState` travels whole on every carrier, replaced by version. Never add a second
  event or answer field for a fact the record carries, and never infer run state from
  arrival order or transcript ancestry.
- An HTTP response both the app and `./mf` read has one schema here, widened to every
  field either host uses. Never add a host-only schema for a shared route.
- Work handles (`w3`) prove syntax, not authority, and URI formatting grants no Work
  access: resolve Work authority before stable serialization.

Cross-package contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md). The review wire:
[`src/branches/.context/CONTEXT.md`](src/branches/.context/CONTEXT.md).
