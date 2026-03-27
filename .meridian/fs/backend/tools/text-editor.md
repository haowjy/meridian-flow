# Text Editor Tool

`str_replace_based_edit_tool` unifies read and write commands while delegating persistence to a mutation strategy.

## Command Surface

The tool supports `view`, `str_replace`, `insert`, and `create` under one executor so model-facing editing semantics stay uniform.

Write commands call `checkEditNamespaceAccess` before document lookup and return structured tool errors for denied paths.

## Mutation Strategies

| Strategy slot | Current behavior |
| --- | --- |
| `DocumentMutationStrategy` interface | Defines one `Apply` entry point for all persistence paths |
| `CollabProposalStrategy` implementation | Converts text diff to Yjs update, creates proposal, and broadcasts accepted/pending events |

The strategy boundary keeps edit command logic independent from collab-specific proposal and websocket flow.

## Namespace Isolation for Writes

| Path pattern | Rule | Rationale |
| --- | --- | --- |
| `.meridian/work/<slug>/` | Only current `workItemSlug` is writable | Prevent cross-work-item leakage |
| `.meridian/fs/` | Writable from any thread context | Shared filesystem namespace |
| `.agents/` | Writable | Change application is review-gated elsewhere |
| `.meridian/<other>` | Denied | System internals |
| `.session/` | Denied | Ephemeral namespace |
| Other workspace paths | Allowed | User-owned workspace |

Denied writes are converted into `DomainError`-backed tool results such as `PATH_TRAVERSAL_DENIED` and `NAMESPACE_ACCESS_DENIED`.

## Canonicalization Order

The write guard canonicalizes with `filepath.Clean` before namespace prefix checks and still rejects raw `..` segments from original input so traversal attempts cannot cross namespace boundaries silently.

## File References

| Area | File references |
| --- | --- |
| Unified tool + command dispatch | `backend/internal/service/llm/tools/text_editor.go:26`, `backend/internal/service/llm/tools/text_editor.go:107` |
| Write-path namespace check before mutations | `backend/internal/service/llm/tools/text_editor.go:267`, `backend/internal/service/llm/tools/text_editor.go:347`, `backend/internal/service/llm/tools/text_editor.go:415` |
| Mutation strategy interface | `backend/internal/service/llm/tools/mutation_strategy.go:5`, `backend/internal/service/llm/tools/mutation_strategy.go:9` |
| Collab proposal strategy | `backend/internal/service/llm/tools/mutation_strategy_collab.go:26`, `backend/internal/service/llm/tools/mutation_strategy_collab.go:49`, `backend/internal/service/llm/tools/mutation_strategy_collab.go:161` |
| Namespace rules + canonicalization invariants | `backend/internal/service/llm/tools/text_editor.go:504`, `backend/internal/service/llm/tools/text_editor.go:518`, `backend/internal/service/llm/tools/text_editor.go:522`, `backend/internal/service/llm/tools/text_editor.go:528`, `backend/internal/service/llm/tools/text_editor.go:539`, `backend/internal/service/llm/tools/text_editor.go:568`, `backend/internal/service/llm/tools/text_editor.go:575` |
| DomainError conversion to tool result | `backend/internal/service/llm/tools/text_editor.go:584`, `backend/internal/service/llm/tools/text_editor.go:587`, `backend/internal/service/llm/tools/text_editor.go:590` |
