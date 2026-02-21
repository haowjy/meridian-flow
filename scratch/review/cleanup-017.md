# Cleanup 017

- Category: Reliability
- File: `frontend/src/features/documents/hooks/useDocumentCollab.ts:377`
- Issue: The main collab lifecycle effect depends on `initialContent`, so content changes can tear down and recreate the Yjs runtime + WebSocket subscription for the same `documentId`.
- Why this is a problem: Re-initializing collab on content updates risks transient disconnects, duplicated setup/teardown work, and lost in-flight state during refreshes.
- Suggested fix:
1. Remove `initialContent` from the effect dependency list.
2. Capture seed content in a ref used only by bootstrap (`tryBootstrap`) for first initialization.
3. Add regression coverage: changing `initialContent` for the same document must not recreate runtime/transport.
