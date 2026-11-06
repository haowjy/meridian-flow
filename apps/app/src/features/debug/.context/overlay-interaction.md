# Debug overlay interaction

The first render stays disabled for SSR parity: resolve the query parameter and stored
preference after mount, not in the `useState` initializer. `?debug=1` is the reliable
escape hatch when the keyboard toggle isn't available.

Virtualized off-screen turns need the virtual list's index API, not DOM anchors.

Composer inspection fetches a next-turn preview without persisting or freezing an
unbaked prompt. Generation counters fence rapid reselection, and a 404 means capture is
unavailable.

The active thread is the thread-store streaming ID, then the chat in the project
address, then null. Don't derive it from the Query cache.
