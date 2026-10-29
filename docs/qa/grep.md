# Model `grep`

Probes for the model's `grep` tool on a target-scale project (150 chapters of 7,000 words
and 300 KB entries of 800 words, 450 documents, 8.2M characters). Each case has what it
must return and the time it is predicted to take
([design](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-definition-design/design/grep-tool.md),
[prediction table](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-definition-design/plan/grep-plan.md#predicted-after-content-mode)).
A case that takes more than twice its prediction is explained before merge.

## Setup

1. `MODEL_PROVIDER=mock pnpm dev` (`./mf` scripts the mock model; a stack with a provider key refuses `--mock`).
2. Generate and seed the project, then wait a few seconds for the derivation to fill
   the block rows (`select count(*) from documents d left join document_block_rooms r on r.document_id = d.id where r.room_id is null and d.file_type is not null` shows 0 underived text documents, and `document_blocks` holds the text):

   ```bash
   node tools/mf/fixtures/grep-scale.mjs > /tmp/grep-scale.json
   ./mf seed /tmp/grep-scale.json --json | tail -1   # threadId; seeding takes about a minute
   ```

   The slow-pattern cases need two more documents in that JSON's `docs`: `kb://probe/long`, one
   paragraph of 1,000,000 letters with no spaces (`loremipsumdolorsitamet` repeated), and
   `kb://probe/sentences`, 50 paragraphs of "He drew the sword from the stone and the mountain shook
   beneath his feet. Lin Feng nodded to Elder Mo at the Jade Pavilion <n>".
3. `T=<threadId>`. Drive one call per reply, scripting the model's `grep`:

   ```bash
   grep_case() { ./mf thread send "$T" go --mock \
     "[{\"toolCalls\":[{\"name\":\"grep\",\"args\":$1}]},{\"text\":\"done\"}]" --json >/dev/null; }
   grep_case '{"pattern":"Azure Dragon Seal"}'
   ```
4. **Time** is the gap between the `tool_use` and `tool_result` blocks of the call (`./mf log`
   has no tool span). It includes the tool executor's own floor, about 35 ms (an
   instant refusal takes that long):

   ```sql
   select round(extract(epoch from (r.created_at - u.created_at)) * 1000) as ms,
          left(r.content->>'output', 200)
   from turn_blocks u join turn_blocks r
     on r.turn_id = u.turn_id and r.content->>'toolCallId' = u.content->>'toolCallId'
        and r.block_type = 'tool_result'
   where u.block_type = 'tool_use' and u.content->>'toolName' = 'grep'
   order by u.created_at desc limit 1;
   ```

   Run it with `docker exec meridian-dev-postgres-1 psql -U postgres -d "meridian_<checkout>" -tA`.
   Time each case three times.

## Cases

Fixture facts: "Lin Feng" opens every document; "Azure Dragon Seal" is in chapters 7, 19, 31, 43,
55, 67, 79, 91 and 103; "Qi Condensation 3 gave way to Qi Foundation 7" is in every tenth
chapter; `LIVE\_ONLY` (escaped) is in chapter-001 only. Seeding `basic.json` earlier adds
`manuscript://Chapter 1` and `kb://characters/Lin Feng`.

| Case | Args | Expect | Predicted | Measured (ms, 3 runs) |
|---|---|---|---|---|
| Literal, 9 documents | `Azure Dragon Seal` | the nine chapters, one passage each | 300–500 | 301, 266, 268 |
| Literal, `-i` | `azure dragon seal`, `-i` | the same nine | 300–500 | 297, 289, 287 |
| No match | `zzqxv` | `No matches.` | 30–300 | 108, 96, 97 |
| No match, `-i` | `ZZQXV`, `-i` | `No matches.` | 30–300 | 97, 95, 94 |
| Regex | `Qi (Condensation\|Foundation) [0-9]+` | 15 chapters, 2 matches each | 300–500 | 495, 425, 453 |
| Word boundary, everywhere | `\bLin\b` | first 50 files, "50 of at least 451 files" | 1000–1500 | 1092, 1005, 1036 |
| Heading anchor | `^#` | first 50 files, each `# Chapter n` | 1000–1500 | 1018, 1002, 1006 |
| Empty-line count | `^$`, `count` | `No matches.` (every block has text) | none | 105, 102, 101 |
| `\A` | `\ALin` | matches at line starts, as `^Lin` | 1000–1500 | 1070, 1083, 1074 |
| `\A`, files only | `\ALin`, `files_with_matches` | files, no reads | 50–300 | 109, 99, 117 |
| Across a line break | `line\sfoo` | `No matches.` | 30–300 | 129, 104, 141 |
| `-i` alternation, everywhere | `lin feng\|su yan\|elder mo`, `-i` | 50 files with 130+ matches each | 1000–1500 | 1201, 1210, 1203 |
| `-i` alternation, count | same, `count` | counts, no reads | 50–300 | 301, 300, 309 |
| Files only, everywhere | `Lin Feng`, `files_with_matches` | 50 URIs and the total | 50–300 | 97, 93, 97 |
| Count, everywhere | `Lin Feng`, `count` | 50 URIs with "(1 match)" | 50–300 | 100, 95, 98 |
| `head_limit` | `Lin Feng`, `head_limit` 5 | 5 files and "5 of at least 451 files" | 200 | 187, 196, 187 |
| Folder | `Lin Feng`, `path` `kb://lore` | `kb://lore/entry-…` only | n/a | 575, 607, 578 |
| Glob, name only | `Lin Feng`, `glob` `*chapter-01*`, `files_with_matches` | `chapter-010` to `chapter-019` | n/a | 42, 69, 66 |
| Glob, address | `Lin Feng`, `path` `kb://`, `glob` `lore/**`, `count`, `head_limit` 2 | `kb://lore/…`, "2 of 100 files" | n/a | 65, 66, 44 |
| One document | `Azure`, `path` `manuscript://book/chapter-007` | that chapter | n/a | 76, 85, 75 |
| Escaped form | `LIVE_ONLY` | chapter-001 (stored `LIVE\_ONLY`) | n/a | 149, 150, 143 |
| Repeat at the limit | `.{100}[a-q]`, `count` | counts | n/a | 362, 322, 327 |
| Slow, under the budget | `[^z]{100}x`, `-i`, `count` | `No matches.` | n/a | 14743, 14744, 14755 |
| Sentence-long pattern | a 72-character sentence from the fixture's `kb://probe/sentences` | that document | n/a | 269 |
| Name alternation | `Lin Feng\|Azure Dragon\|Heavenly Sword Sect\|Elder Mo\|Jade Pavilion`, `count`, `path` `kb://probe/sentences` | 150 matches | n/a | 60 |
| Pathological | `(a+)+$`, `count`, `path` `kb://probe/sentences` | `No matches.` | under 50 beyond the floor | 52, 51, 45 |

Refusals (`isError`), each in about 30–50 ms: `(?<=a)b` and `[` ("Invalid pattern: error parsing
regexp…"), `(a)\1`, a 513-character pattern ("Invalid arguments for grep: pattern: must be at
most 512 characters") and `path` `skills://` ("grep doesn't cover skills://"). RE2's own
limits apply (repeat counts up to 1000). Nothing else is refused for cost: a slow pattern runs
until the 20 s budget ends it.

State cases (mock script with a `write` step before the `grep`):

- **Staged text in the same reply.** `write` `insert` into `manuscript://book/chapter-004`
  "ZEBRAFINCH staged sentence.", then `grep` `ZEBRAFINCH`: finds chapter-004. The projection is
  current and has no draft row, so only the reply's staged-write check keeps it off the fast path.
- **Edited seconds ago.** The same text found in the next reply before the derivation ran, and after.
- **Draft-mode Work.** In a chat moved to a Work (`work` `create`, `switch`) with `write_mode`
  `draft`, insert "DRAFTONLYTOKEN" in chapter-006. `grep DRAFTONLYTOKEN` in that chat finds it;
  in a chat with no Work, and with `version: live` in the draft chat, it finds nothing.
- **Narrowed Agent access.** Not run live here: `compose.file-access-tools.db.test.ts` runs the
  tool through the file-access policy. Access is asked for before any document is matched or counted
  (`ContextFS.grep`), so neither the results nor the total can include an unreadable document.

## Browser cases

Drive these in the browser (`agent-browser`) on a `MODEL_PROVIDER=mock` stack, scripting the model
with `./mf thread send … --mock`, and expand each tool step in the transcript. They check what the
writer sees; the timing cases above stay the scale checks.

- **Multi-block passage.** Seed a document with several paragraphs and put the pattern in the third
  (and again in a different one for a second document). Click the passage in the card: the editor
  opens on that paragraph, not the first block.
- **Editor edit, then grep.** Open a document, select all, type new text, and wait for the editor to
  say it is saved and connected. Collab-ready check before trusting the result: the browser's network
  log shows the Yjs WebSocket upgrade with status 101 and `./mf doc read` returns the new text; an
  editor stuck on "Saved locally (offline)" has not persisted yet, so the grep sees the old text. Then
  `grep` the new text (found) and the old text (no passage).
- **Lower-bound wording.** Seed 55 small documents with one token and run `grep` with `head_limit` 2.
  The heading reads "At least 55 documents" and the footer reads "2 of at least 55". Both say lower
  bound; a footer of "2 of 55" is a regression. Also check the exact case ("2 of 55" with a plain
  heading) when the scan finishes.
- **Work draft across replies.** In a Work with `write_mode` `draft`, `write create` a document
  containing a token in one reply, then `grep` for it in a later reply of the same chat: found, and
  the draft shows in the change bar. A chat with no Work, and `version: live` in the draft chat,
  find nothing.
- **Trash preview.** Delete a document from its Actions menu, open Trash: the preview shows its
  current (edited) text. Restore it afterwards.
- **Moved-link destination.** Link document A from document B, move A to another folder, then open
  the link from B's text: it lands on A at its new address.
- **Move-only ordering.** Record each `updated_at` in the project's recently-updated order, move one
  document without editing it, and read them again. The moved document's own `updated_at` changes (the
  tree bumps it on a move; `main` does the same). The `updated_at` of every document that links to it
  does not: re-deriving them after the move is not an edit, so none of them jumps to the top.
- **`ls -v` counts and file-tree sizes.** `ls` with `verbose: true` returns a word count per
  document; read it from the tool result (`./mf log` or the `turn_blocks` row's `output`), because the
  expanded card shows names only. Compare it with the file tree's size label for the same document;
  both should come from the same count.

## Measured against predicted

Run on the worker-thread commit (its hash is in the PR), 2026-10-27, the shared dev machine
(about 1.5–2× slower that day than for the earlier rows: the same cases on the previous
commit measured 190–200 ms for a files-only grep that had read 100 before),
Postgres 16 in the local container, `MODEL_PROVIDER=mock`. Rows from the literal through the
count-everywhere cases were re-run on it and match the previous commit's timings on that
day, so the worker adds nothing visible (1,000 request round trips to a warm thread
take 53 ms; the first request starts a thread, about 125 ms). The glob, one-document and
escaped-form rows are from the review-fix commit. The notes below explain the slow and the fast.

- `\bLin\b`, `^#` and `\ALin` (content, everywhere), 1.05–1.1 s: 50 reads and passages. The
  prediction is 1–1.5 s.
- `-i` alternation with content, 1.3 s against 1–1.5 s: 50 reads, and blocks that each hold
  130 matches to count and window.
- `-i` literal and `-i` no-match are 310 and 110 ms: a case-insensitive pattern first needs the
  literal it requires (`azure dragon seal`, `zzqxv`) to appear in the document, a plain
  substring test, before `re2js` reads it. Without a required literal (`[^z]{100}x`) every line
  goes through `re2js`: that pattern takes about 15 s over 8.2M characters.
- "of at least N files": documents with an active draft row (here chapter-006) or a stale
  derivation take the slow path, and past the limit they are not read to be counted.

Limits, checked live:

- **Slow patterns.** Matching runs in worker threads (`grep/match-pool.ts`) that the budget
  terminates. Sentences and alternations a writer would search for pass (a 72-character
  sentence, `Lin Feng|Azure Dragon|Heavenly Sword Sect|Elder Mo|Jade Pavilion`, `Lin.{0,50}sword`).
  `(?:\pL{100}){10}\d` on a 1,000,000-letter line (`kb://probe/long`, seed it beside the fixture)
  ends at the 20 s budget with "No matches found before the search stopped"; `GET /healthz` stays at
  4–5 ms throughout, and so does it with two such greps at once, while an ordinary grep in a third
  chat takes its usual time plus the thread's start (about 0.1 s).
- **Concurrency.** Up to 4 threads run at once; a fifth caller waits for a free thread for at most its own budget.
- **Budget.** The scan stops after 20 s and returns what it found; the result then reads
  "No matches found before the search stopped" or "N of at least M files".
