# Debug overlay interaction

This page defines activation and inline inspection. Keep the first render
disabled for SSR parity and bind lazy responses to the selected target.

## Activation

`use-debug-enabled.ts` gates the surface by build flag, then `?debug=1`
persists the preference in `localStorage`. Command-Control-D on macOS or
Control-Shift-D elsewhere toggles it; the query parameter remains the reliable
escape hatch. Resolve query and stored preference after mount, not in the
`useState` initializer.

## Inline inspection

`InlineInspector` installs one capture-phase click listener while enabled.
Alt+click resolves the nearest `[data-block-id]`, then
`[data-turn-id]`, then `[data-debug-composer]`, and prevents the app click.
Store records are read from the thread store; absent records still show DOM IDs.
Virtualized off-screen turns require the virtual list's index API, not DOM anchors.

Composer inspection lazily fetches an owner-gated next-turn preview without
persisting or freezing an unbaked prompt. Turn/block inspection lazily fetches
the selected model request and uses shared Markdown, Raw, and Debug views.
Generation counters fence rapid reselection; 404 means capture unavailable.

The active thread is the thread-store streaming ID, then the chat in the project
address, then null. Do not derive it from the Query cache.
