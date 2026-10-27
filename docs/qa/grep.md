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
   `grep_text` (`select count(*), count(grep_text) from document_markdown_projections` shows equal counts):

   ```bash
   node tools/mf/fixtures/grep-scale.mjs > /tmp/grep-scale.json
   ./mf seed /tmp/grep-scale.json --json | tail -1   # threadId; seeding takes about a minute
   ```
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
| Repeat at the limit | `.{100}[a-q]`, `count` | counts | n/a | 241, 228, 230 |
| Slowest allowed pattern | `[^z]{100}x`, `-i`, `count` | `No matches.` | n/a | 8848, 9155, 8819 |
| Pathological | `(a+)+$`, `count`, `path` `kb://probe/aaa` (10,000 `a`) | one match | under 50 beyond the floor | 54, 44, 60 |

Refusals (`isError`), each in about 30–50 ms: repeat counts that add up past 100 (`.{101}x`:
"repeat counts add up to 101, above the limit of 100"; also `(?:\pL{100}){10}x`, 1000, and
`[^z]{100}[^z]{100}x`, 200; `[x{200}]` is a class and passes), `(?<=a)b` and `[` ("Invalid pattern: error parsing
regexp…"), `(a)\1`, a 513-character pattern ("Invalid arguments for grep: pattern: must be at
most 512 characters") and `path` `skills://` ("grep doesn't cover skills://").

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

## Measured against predicted

Run on the round-2 commit (its hash is in the PR), 2026-10-27, the shared dev machine,
Postgres 16 in the local container, `MODEL_PROVIDER=mock`. Every row is warm. Rows not
re-run after the round-2 change (the glob, one-document, escaped-form and pathological rows) are
from the review-fix commit. Every case is inside its
prediction; the notes below explain the slow and the fast.

- `\bLin\b`, `^#` and `\ALin` (content, everywhere), 1.05–1.1 s: 50 reads and passages. The
  prediction is 1–1.5 s.
- `-i` alternation with content, 1.3 s against 1–1.5 s: 50 reads, and blocks that each hold
  130 matches to count and window.
- `-i` literal and `-i` no-match are 310 and 110 ms: a case-insensitive pattern first needs the
  literal it requires (`azure dragon seal`, `zzqxv`) to appear in the document, a plain
  substring test, before `re2js` reads it. Without a required literal (`[^z]{100}x`) every line
  goes through `re2js`: the slowest allowed pattern takes about 10 s over 8.2M characters.
- "of at least N files": documents with an active draft row (here chapter-006) or a stale
  derivation take the slow path, and past the limit they are not read to be counted.

Limits, checked live:

- **Repeat counts** that add up past 100 are refused. At 250 the same `-i` pattern took 19 s over
  this project, at 100 about 9 s, inside the scan's 20 s budget. The bound also covers one long
  line, which the budget cannot interrupt: one `re2js` call on a 1M-character single line took
  at most 2.0 s at weight 100 (`[^z]{100}x` over text of all `a`; 0.6 s over prose). Chains the
  old per-repeat cap allowed took 3.8 s (two), 9.4 s (five) and 18.9 s (ten), and
  `(?:\pL{100}){10}x` 29 s.
- **Event loop.** A scan of a pattern with no literal yields every 10 ms between lines. While
  `[^z]{100}[^y]{100}x` (`-i`) ran for 12 s, `GET /health` took about 240 ms; with the yield
  between documents it took 3 s.
- **Budget.** The scan stops after 20 s and returns what it found; the result then reads
  "No matches found before the search stopped" or "N of at least M files".
