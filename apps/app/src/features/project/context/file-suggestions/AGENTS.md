# context/file-suggestions — client-side file finding

Reusable file suggestions over the normalized context catalog. This module
ranks locally; React Query owns catalog acquisition and it must not introduce a
server-search path or suggestion-specific cache.

## Mental model

- `file-suggestions.ts` is the pure core: project normalized entries, filter by
  scheme/kind, then rank by leaf prefix, leaf word boundary, and full path.
- `use-file-suggestions.ts` composes the three warm scope queries and exposes
  suggestions plus aggregate fetch/error state.
- `FileSuggestionList.tsx` is keyboard-accessible presentation. Hosts own the
  input, popover, selection effect, and allowed schemes/kinds.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for the contract and hosts.
