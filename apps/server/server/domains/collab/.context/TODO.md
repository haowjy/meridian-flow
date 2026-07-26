# collab TODO

## Draft preview fails on empty paragraphs

The real-stack adversarial-editing probe `p3511` saw the draft-preview endpoint return
HTTP 500 four times when the draft contained empty paragraphs:
`Cannot anchor text offset in block <id> (paragraph) without text`. Reproduce at the
draft-preview anchoring seam and make empty text blocks a supported preview input; this
is pre-existing and was not part of the loaded-room live-pull fix.

## Code files become a display lens; cross-schema rename becomes a metadata flip

**Tracked:** [#212](https://github.com/haowjy/meridian-flow/issues/212) — direction
decided 2026-07-14, awaiting tech-lead scoping.

**Current (shipped):** the client mounts a constrained schema for code (exactly one
`code_block`; `config.ts` `CodeDocument`) and the server serializes code verbatim from
**block 0 only** (`markdown-document.ts`); document ↔ code renames return typed
`invalid_operation` (`context-fs.move-filetype` tests pin this) because remounting the
other schema against existing content would let ProseMirror normalization delete it.

**Decided direction:** one schema everywhere; "code" is presentation + input policy +
line-oriented verbatim serialization, never a different mounted schema. Disabling prose
affordances must be input policy (commands/paste/transaction filters), NOT schema node
removal — an absent node type re-creates the silent-deletion class (#196/#203). Then
rename md ↔ py is a metadata flip, and `CodeDocument` + the block-0 serializer hazard are
deleted. Scoping open: whitespace roundtrip fidelity, doc-wide highlighting (or none in
v1), code-lens paste flattening, migration of existing single-`code_block` docs.
