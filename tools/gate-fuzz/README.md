# gate-fuzz (throwaway, never merged)

Phase 0 gate 2 of the move to Loro: the block-level diff-and-merge model on the real schema, fuzzed.
Results, the case mix and the failure classes: `loro-build/gate/2-fuzz/README.md` in the docs repository.

```sh
pnpm install --ignore-workspace          # needs the monorepo's own `pnpm install` first (ProseMirror is linked from it)
node --import tsx fuzz.mjs --n 1000 --approach B                                   # upstream loro-prosemirror@0.4.4
GATE_BINDING=$PWD/binding-fork/index.ts node --import tsx fuzz.mjs --n 1000 --approach B --undo inverse --reshare
node --import tsx fuzz.mjs --seed 37 --verbose                                     # one script, step by step
node --import tsx repros.mjs                                                       # the minimal repros
OUT=/tmp/gate-runs N=10000 ./run-gate.sh && node merge.mjs /tmp/gate-runs          # the gate, two processes at a time
```

- `block-diff.mjs` is the model (no ProseMirror): what Phase 2a would lift into `packages/document-model`.
- `codec.mjs` is the real schema through the binding; `gen.mjs` the seeded edits; `fuzz.mjs` the scripts and the oracle.
- `binding-fork/` is `packages/loro-prosemirror/src` from `gate/loro-binding` at `8dca45aa`, copied so one
  `loro-crdt` and one `prosemirror-model` are loaded.
- Free every `LoroDoc` (and fork, `forkAt` view, `UndoManager`) explicitly, and let the event loop turn between
  scripts: loro-crdt frees container handles from a FinalizationRegistry callback. Without both, 2,500 scripts
  grew one process to 2.5 GB.
