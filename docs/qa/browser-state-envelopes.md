# Browser state envelopes

Start `pnpm dev` in the owned worktree, discover the HTTPS URL with
`pnpm portless:list`, and sign in through dev-login. Use `./mf doc put` to seed
a long chapter in a folder, plus a second document, and `./mf thread create`
to create a chat. No model send is needed.

1. In Chat, select the chat, type an unsent draft, and open a document in the
   side panel. Reload. The same chat, draft, side-panel document, and native
   view return.
2. Open that document in Editor, then open the second document. Reload.
   Both tabs return in order, with the last-selected tab active. The docked
   chat keeps the same unsent draft.
3. In the long chapter, select some text and scroll well below the opening.
   Reload. The viewport returns to the same passage; the editor's selection
   returns without stealing focus. See [reading position](reading-position.md)
   for collaborative edits and explicit-navigation precedence.
4. Expand the seeded folder, reload, and check its children remain visible.
   Collapse it and reload again; the explicit collapse also returns.
5. In browser storage inspection, copy a valid current-chat record from
   account A's key into account B's key. Read as B, with the other tier empty:
   no foreign selection restores. Repeat for current-work and both tiers,
   and for foreign project/kind stamps. Explicit null is valid, not absent:
   another tab changing the device seed must not replace an empty tab choice.
6. Malformed JSON, wrong versions, or old unstamped records must be ignored.
   Denying either storage tier must leave interaction usable, and failure in
   one selection write must not suppress the independent other-tier write.

The helper and selection tests exercise the transplant and unavailable-storage
boundaries hermetically. Composer hand-off still deletes the record and retains
its dirty draft if deletion fails. The account settings cache uses the same
envelope; the pre-paint theme script reads it with the runtime validator, and
`account-settings-cache.test.ts` checks both readers accept the same records.
Stop this stack with `pnpm dev:stop`.
