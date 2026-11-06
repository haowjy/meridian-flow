# Browser memory across a reload

Start `pnpm dev` in the owned worktree, discover the HTTPS URL with
`pnpm portless:list`. The stack runs with `DEV_AUTH_BYPASS=1`, so the app opens signed in. Use `./mf doc put` to seed
a long chapter in a folder, a second document, and `./mf thread create` to make
a chat. No model send is needed.

1. In Chat, select the chat, type an unsent draft, and open a document in the
   side panel. Reload. The same chat, draft, side-panel document, and native
   view return.
2. Open the long chapter in Editor, scroll below the opening, and place the
   caret mid-paragraph. Reload. The same passage returns at the top of the
   viewport with the selection intact, without taking focus. Insert paragraphs
   above it from another tab, then close and reopen the chapter: the same text
   and caret return, not the old paragraph number. Delete the remembered
   paragraph from the other tab; reopening leaves a surviving position or the
   top, never an error.
3. Open the long chapter in Editor, then open the second document. Reload: both
   tabs return in order, the last-selected tab is active, and the docked chat
   keeps its unsent draft. Close and reopen the chapter tab, then open its URL
   in a new browser tab; the remembered place returns. Carry the chapter into
   Chat's side panel, move the caret and scroll, then reload; the side-panel
   document returns at its latest place.
4. Open a Changes card, search passage, or inline draft review. That target
   opens instead of the remembered place. A URL with `?item=` or a fragment
   suppresses restoration.
5. Expand the seeded folder, reload, and check its children remain visible.
   Collapse it and reload again; the explicit collapse returns.
6. Copy a valid current-chat record from account A's browser storage key into
   account B's key. Read as B with the other tier empty: no foreign selection
   restores. Explicit null remains a valid empty choice when another tab
   changes the device seed.

Stop this stack with `pnpm dev --stop`.
