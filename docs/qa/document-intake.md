# Writer names at document intake

Run on an owned worktree and database. Start with `pnpm dev` and discover the
URLs with `pnpm portless:list`. These are manual steps, not automated test evidence.

## Bootstrap and CLI

1. On a fresh dev account, run `./mf project default` and
   `./mf doc read "manuscript://Chapter 1" --json`. The bootstrap chapter is
   `Chapter 1`, with no prose suffix.
2. Run `./mf doc put "manuscript://Intake Probe.TXT" --text '# Probe' --json`.
   Creation reports `manuscript://Intake Probe`.
3. Read that document through `Intake Probe.md`, `Intake Probe.markdown`,
   `Intake Probe.mdx` and `Intake Probe.txt`. Every spelling returns the same
   content and canonical URI. Remove it with
   `./mf doc rm "manuscript://Intake Probe.markdown" --json`.

## Uploads and corpus import

Using the owned app's upload and KB import controls:

- Upload `Chapter 13.md`, `.markdown`, `.mdx` and `.txt`. The first is
  `Chapter 13`; further collisions become `Chapter 13 (2)`, then `(3)` and
  `(4)`. Intake metadata retains each original filename.
- Include `# A heading`, `<10 degrees`, `{The crowd roared}` and `*loudly*`
  in the text. Headings and emphasis retain their Markdown meaning; angle
  brackets and braces retain the writer's literal text.
- Upload extensionless `config` with `application/json` MIME, and `Pic.PNG`
  with image MIME. They appear as `config.json` and `Pic.png`.
- Import `Chapter 13.docx`, `Vol. 2.docx`, and another `Chapter 13.docx`
  through KB/corpus conversion. Their names under `imports` are `Chapter 13`,
  `Vol. 2`, and `Chapter 13 (2)`. Parent directory spelling is preserved.
  Raw identity-bound DOCX upload is separate binary intake, not conversion.
- Import `ch1.md`, `ch1` and `ch1.txt` together, then repeat in reverse order
  into a fresh destination. `ch1` keeps its name; `.md` becomes `ch1 (2)` and
  `.txt` becomes `ch1 (3)` in either order. Include `Lore.md` beside a file
  with relative path `Lore/entry.md`: the folder remains `Lore` and the
  colliding document becomes `Lore (2)`.

## Download and cleanup

Download the prose document through `/api/documents/<documentId>/download`.
It leaves as `<writer name>.md`; a non-prose document retains its stored
filename. Inspect `Content-Disposition` for both the ASCII fallback and the
UTF-8 name when checking a non-ASCII title. Binary downloads from this route
serve the stored bytes, rather than redirecting to an opaque object key.

Delete only these probe documents/imports, remove unused upload identities
through their exact delete operation, then stop this worktree with
`pnpm dev --stop`.
