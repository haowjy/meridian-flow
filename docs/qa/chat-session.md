# Chat session recipes

Runtime checks that the chat the browser draws and the chat `./mf` prints are the
same view model. `./mf` reaches the browser's answer to "which rows does the writer
see, and what does each reply show" because both run `viewTranscript` from
`@meridian/thread-client`; this page is where the recipes for the session's commands
will grow, one per command. Today it holds the transcript comparison.

## Compare a chat in the browser with `./mf thread view`

- **Protects:** the app draws the view model it is handed, and nothing in a
  component re-decides a row. A divergence is a binding bug (a component dropping,
  reordering or re-classifying) or an input the two sides don't share.
- **Stack:** mock model, an owned worktree stack (`MODEL_PROVIDER=mock pnpm dev`,
  `pnpm portless:list`). **Confirm route ownership before any `./mf seed` or send** (#615):
  `pnpm portless:list` must show routes for your own session, and `MF_APP_URL` and
  `MF_SERVER_URL` must be passed explicitly. A detached checkout can report "started" while
  its routes belong to another checkout, and `./mf` would then write into that checkout's
  database. Build one chat with `./mf` so both sides read the same durable turns:

  ```bash
  ./mf seed tools/mf/fixtures/basic.json --json            # chat + opening reply
  ./mf thread send "$T" 'Draft a scene' --mock @tools/mf/fixtures/mock-write.json --json
  ./mf thread send "$T" 'Spawn a check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect","name":"Check","mode":"background"}}]},{"text":"Child."},{"text":"Started."},{"text":"Done."}]' --json
  ./mf api POST /api/threads/$T/controls --data '{"id":"<uuid>","control":{"kind":"compact"}}'
  ```

- **Steps:**
  1. Read the model: `./mf thread view "$T" --full --json > view.json`. `--full --json` is
     the inspectable form: tool inputs and results, card content, report payloads, the
     handoff brief, delivery bodies and writer occurrences. Text mode
     (`./mf thread view "$T"`) summarizes (`you:`, `reply: read 2 docs, 1 step`,
     `compaction:`, `queued: N`) and omits all of that; use it to orient, not to compare.
  2. Open the chat in the browser (`/p/<projectId>/chats/<threadId>`, signed in through
     the stack's dev login).
  3. **Scroll every row into view and expand every process fold first.** The list is
     virtualized, so rows outside the viewport are not in the DOM, and folds start
     collapsed, so their tools are not either.
  4. Compare, per row in order, by **row identity** (`identity.turnId`, `identity.kind`,
     `identity.occurrence`; the DOM carries the turn id as `data-turn-id` and the kind as
     `data-chat-turn-kind`; compaction and handoff-seed rows carry `data-turn-id` on their
     list item too), **row kind**, **render-item kinds** (`data-turn-item-kind`:
     `process`, `text`, `report`, `artifact`, `delivery`) and **visible text** (the
     `text` of `text` items and a writer row's `text`).
     - **Deliveries:** the JSON lists a reply's delivery groups as a last `delivery` item
       (`groups`, each a list of events), the DOM's trailing `delivery` item; a group of
       several is one merged row.
     - **Text:** the DOM collapses newlines and draws references as chips, so compare after
       whitespace normalization and after rendering a reference to its title (the JSON's
       `text` holds the reference as Markdown, and `occurrences` locates it).
     - **Folds:** compare fold contents by the tool names and targets in the full JSON
       (`runs[].tools[].name`, `input`), not by label words.
     - **Cards, reports, brief:** compare a card's `title` and `outcome`, a report's
       `summary`, and a handoff row's `brief`, against the DOM text.
  5. Never compare render keys. `renderKey` is the React key and may change when a
     local turn is renamed to its server id.
- **Expect:** same rows in the same order; each reply's item kinds match, with a fold
  whose `visible` is false absent from the DOM; folds expand to the tools the model
  lists (`runs[].tools`); the fold's label words the model's `digest` counts ("Read 2
  documents"); a reply with `continuing: true` has no action row.
- **Known input differences, not defects.** `inputs` says what `./mf` left out:
  - local records and stand-ins (a Retry's pending reply, an unsent message), so
    compare only settled chats;
  - live subagent activity, so a reply that the browser holds open for a running
    background subagent shows `continuing: false` in `./mf`;
  - inherited fork history, omitted from `./mf`'s rows;
  - copy and the receipt rows under a reply (Undo, "Edited 1 document") are the app's
    drawing of Work and lineage reads, not view-model rows.
- **Evidence:** `view.json`, the browser snapshot or DOM extract per row, and the row
  table of identity, kind, items and text from both sides. Record commit, date, stack
  and provider.
- **Last run:** not recorded on a merged commit. PR C's author compared the chat's rows,
  folds and text by eye in the browser on a mock stack
  (`work/mf-client-unification/evidence/pr-c-transcript-view/`).
