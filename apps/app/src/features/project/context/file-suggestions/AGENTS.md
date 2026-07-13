# context/file-suggestions — client-side file finding

Reusable file suggestions over the project's cached context trees. This module
ranks locally; it does not own fetching policy beyond composing existing tree
queries and must not introduce a server-search path.

## Mental model

- `file-suggestions.ts` is the pure core: flatten tree entries, filter by
  scheme/kind, then rank by leaf prefix, leaf word boundary, and full path.
- `use-file-suggestions.ts` composes the five cached scheme queries and exposes
  suggestions plus aggregate fetch/error state.
- `FileSuggestionList.tsx` is keyboard-accessible presentation. Hosts own the
  input, popover, selection effect, and allowed schemes/kinds.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for the contract and hosts.
