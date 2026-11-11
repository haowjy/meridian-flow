# Local-first process spike

Throwaway proof; not safe for writer data. No local API is implemented. The daemon passes the same stored state for A and B, so concurrent live changes are not exercised. It does not track renames or deletions, and its in-memory binder uses static link scopes. Attribution is not established. The SQL commit and file write are separate: a crash between them is not atomic. An outside write while the core runs can also be overwritten.

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
bun build apps/server/server/domains/collab/local-first-poc/core.ts --target=node --outfile=/tmp/core.mjs
cargo build --release --manifest-path apps/server/server/domains/collab/local-first-poc/daemon/Cargo.toml
mkdir -p /tmp/example-project
printf 'Example chapter.\n' > /tmp/example-project/chapter.md
apps/server/server/domains/collab/local-first-poc/daemon/target/release/local-first-spike /tmp/example-project /tmp/example.db node /tmp/core.mjs
```

One newline-delimited JSON request per line is sent to the core. `a` and `b` are base64 Yjs updates or absent for a new document; `text` is the file and `actor` names the author. The response has `state`, `update`, `markdown`, `changed`, and `ok`. All document interpretation stays in the core. Existing Markdown is imported when no stored state exists. The daemon logs timing to stderr, measured from the first filesystem event, and skips unchanged hashes before calling the core. `watcher_ms` includes debounce and queued work; startup scan entries do not measure watcher delay. Do not use the same database for another root.
