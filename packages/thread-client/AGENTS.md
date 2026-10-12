# @meridian/thread-client

The thread client core shared by the app and `./mf`: the thread socket client, the message builder, and (phase 2)
reply following. Code lives here when the two clients would otherwise disagree about what happened.

- Framework-free and platform-neutral: no React, no stores, no browser or Node globals touched at module
  evaluation, no `import.meta.env`, no DOM types in the public surface. Platform differences enter through ports
  injected at each client's composition root.
- Depends on `@meridian/contracts` for wire types and readers. Never on `apps/` or server code.
- Each client keeps its own I/O policy (HTTP, auth, persistence, printing, the store).

## Message documents

`serializeMessageDoc` reads plain JSON, preserving authored spacing and occurrence order.
References spell canonical Markdown links through `@meridian/markup/links`; image-capable
references also emit an image block. Submitted identities deduplicate by document and URI,
with draft-upload metadata taking precedence. Skills activate once per slug but every
occurrence remains in the blocks. Draft snapshots and upload lifecycle ownership stay in the app.
