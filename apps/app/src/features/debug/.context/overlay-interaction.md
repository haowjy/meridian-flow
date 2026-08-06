# Debug overlay interaction

## Activation

`use-debug-enabled.ts` applies three gates:

1. `DEBUG_FEATURE_ALLOWED` excludes the surface from ordinary production
   builds.
2. `?debug=1` enables the surface and persists the preference as
   `meridian:debug-overlay` in `localStorage`.
3. Command-Control-D on macOS or Control-Shift-D elsewhere toggles the persisted
   preference. Because macOS may reserve the shortcut, `?debug=1` is the
   reliable way to enable it.

The first client render must stay disabled to match SSR. Resolve the query
parameter and stored preference after mount; reading them in the `useState`
initializer causes a hydration mismatch.

## Inline inspection

`InlineInspector` installs one capture-phase click listener while the overlay is
enabled. Alt+click resolves the nearest target in this order:

1. `[data-block-id]`
2. `[data-turn-id]`
3. `[data-debug-composer]`

The gesture prevents the application's click handler. Turn and block records
come from the thread store; if a record is absent, the inspector still shows
the DOM identifiers. This works with virtualization because the user can only
click mounted rows. Navigation to an off-screen turn must use the virtual
list's index API instead of DOM anchors.

Alt+clicking the composer lazily fetches an owner-gated preview of the next
turn's system prompt, advertised tools, and gateway parameters. Preview assembly
must not persist or freeze an unbaked prompt.

For a turn or block, **model requests** lazily fetches
`GET /api/threads/:threadId/debug/model-requests?turnId=…`. The inspector uses
the shared Markdown, Raw, and Debug views and selects one iteration at a time.
A 404 means capture is unavailable. Generation counters bind every in-flight
response to the selected target so rapid reselection cannot display stale data.

## Active thread

Resolve the pill's active thread in this order:

1. `useThreadStore((state) => state.streamingThreadId)`
2. `/chat/$threadId`
3. the project route's `?thread=…` search parameter
4. `null`

Do not derive active-thread state from the query cache; TanStack Query Devtools
already exposes that cache.
