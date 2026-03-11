# Real-World Collab Traffic Research for Meridian

## Problem Statement

Meridian is building WebSocket-based collaborative editing for long-form fiction projects, including 100+ chapter web serials. The question is not "what can happen in theory?" but "what actually happens in production, and what should Meridian defend first?"

The highest-value areas are:

1. Realistic WebSocket/Yjs payload sizes
2. Realistic multi-document subscription behavior
3. Common WebSocket attack paths
4. Failure modes that actually show up in Yjs/CRDT systems
5. Writer-specific traffic patterns
6. Reliability targets worth engineering toward

## Codebase Context

Current Meridian collab behavior already bakes in some strong assumptions:

- `backend/internal/handler/collab.go:33` sets `collabMaxMessageBytes = 64 * 1024`. Every project WebSocket is capped at 64 KiB through `conn.MaxPayloadBytes` in `backend/internal/handler/collab_project.go:52`.
- `backend/internal/handler/collab.go:36` rate-limits inbound traffic to 30 messages per second and mutes for 1 second when exceeded.
- `backend/cmd/server/main.go:293-298` caps each project WebSocket at 10 concurrent document subscriptions.
- `backend/internal/service/collab/proposal_service.go:20` caps proposal Yjs updates at 256 KiB.
- Scratchpad findings already show three concrete risk areas:
  - oversized WebSocket frames currently tear down the socket instead of gracefully rejecting (`tests/.scratchpad/bugs-found.md`, item 9)
  - multi-document follow-up sync can be routed to the wrong document (`tests/.scratchpad/bugs-found.md`, item 10)
  - origin validation is currently permissive (`tests/.scratchpad/bugs-found.md`, item 11)

Those limits are defensible for human typing, but some are below what real systems treat as exceptional-but-legitimate payloads.

## Findings

### 1. WebSocket frame sizes in production collab systems

#### What is common

- Yjs updates are binary and compressed by design. The Yjs docs describe document updates as "binary encoded (highly compressed)" and note that merged updates are smaller than separate updates ([Yjs document updates](https://docs.yjs.dev/api/document-updates)).
- Kevin Jahns' benchmark shows why normal editing traffic is usually small:
  - in a real editing trace for a 17-page paper with 182,315 inserts and 77,463 deletes, the final encoded document was about 160 KB and parsed in 20 ms ([Are CRDTs suitable for shared editing?](https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing))
  - copy-pasting a huge text chunk still creates only one logical insertion item in Yjs, so "big paste" is much less pathological than "millions of tiny fragmented edits" ([same source](https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing))
- For writing workloads, steady-state incremental updates are usually tiny:
  - keystrokes, short deletions, cursor moves, proposal accept/reject operations, and awareness traffic are generally bytes-to-low-KB events
  - even medium paste operations are usually far below 1 MB unless the editor is serializing entire state, embedding blobs, or replaying a large backlog

#### What is realistic but exceptional

- A full encoded Yjs document can absolutely exceed 1 MB. Kevin Jahns' benchmark for a huge document repeated from a real-world editing trace produced:
  - `docSize`: 15,989,245 bytes
  - `parseTime`: 1952 ms
  - final text length: 10,485,200 characters
  - conclusion: "Pulling a large document with a size of 10 MB from the network" can dominate total load time ([same source](https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing))
- Even Yjs' worst-case synthetic test with one million single-character insertions still encoded to about 1,000,046 bytes ([same source](https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing)).
- Liveblocks explicitly treats `>1 MB` WebSocket messages as unsupported and added `largeMessageStrategy` options to either split the message or fall back to HTTP ([Liveblocks week 6 2025 changelog](https://liveblocks.io/changelog/week-6-2025)).

#### What is mostly theoretical or self-inflicted

- 10 MB incremental updates are not normal human-edit traffic. They are usually one of:
  - initial sync of a very large document
  - replay of accumulated offline edits
  - bulk import/migration
  - sending full document state instead of diffs
  - embedding binary/blob/base64 content in the CRDT
- A 10 MB frame is plausible in production, but usually as a sync/bootstrap problem or architecture mistake, not as steady-state editor traffic.

#### Meridian implication

- **1 MB is realistic enough that Meridian should have a deliberate strategy for it.**
- **10 MB is not a normal interactive frame target, but Meridian should still have a non-catastrophic path for initial sync/import.**
- Meridian's current 64 KiB socket cap is safe for normal typing, but likely too small for some legitimate bootstrap/paste/proposal-import scenarios.
- The right model is:
  - small incremental updates over WebSocket
  - large bootstrap/import/state transfer through chunking, snapshot fetch, or HTTP fallback
  - graceful oversize rejection without killing the entire socket

### 2. Multi-document subscription patterns

#### What real users actually do

- Writing tools are heavily chapter/document oriented, not "one giant canvas" oriented.
- Scrivener explicitly promotes:
  - jumping between current and earlier chapters via the Binder
  - viewing multiple chapter/scene documents as one sequence
  - selecting arbitrary non-contiguous documents for read/edit passes ([Scrivenings article](https://www.literatureandlatte.com/blog/view-and-edit-multiple-documents-with-scrivenings))
- Liveblocks' Yjs guidance says subdocuments are only needed when:
  - you have multiple very large Yjs documents in the same room
  - you need to lazy-load documents individually
  - for most apps, including multiple text editors on the same page, a simple `Y.Map` layout is preferred ([Liveblocks Yjs best practices](https://liveblocks.io/docs/guides/yjs-best-practices-and-tips))

#### Realistic churn rates

- Common writer behavior:
  - 1 active chapter
  - 1 reference chapter or notes doc
  - occasional outline/character/world doc
  - rapid tab switching during revision or continuity checks
- Realistic active subscriptions for Meridian:
  - common: 1-3 documents
  - heavier but normal: 4-8 documents during split-pane, side references, or compare/revision workflows
  - unusual: 10+ truly live docs on one socket
- Realistic churn:
  - a few subscribes/unsubscribes per minute is normal
  - bursts of tens per minute are plausible during search/navigation/review workflows
  - hundreds per second is not human behavior and should be treated as abuse or a client bug

#### What Meridian should worry about

- Meridian's limit of 10 live subscriptions per connection is probably fine for writers.
- The dangerous part is not the ceiling itself. It is:
  - wrong-document routing on multiplexed responses
  - expensive subscribe/unsubscribe thrash
  - forcing project-wide search/navigation to require live Yjs subscriptions
- Project-wide search, tree browsing, and metadata previews should not require live collab subscriptions to every document.

### 3. Common WebSocket attack vectors

#### Common and serious

- OWASP calls out WebSocket-specific risks including CSWSH, authentication bypass, injection, connection exhaustion, and monitoring gaps ([OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)).
- PortSwigger describes CSWSH as a CSRF-style handshake weakness that gives the attacker full two-way interaction with the victim's socket when the handshake relies only on cookies and lacks unpredictable validation ([PortSwigger Academy](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)).
- OWASP also cites a real-world Gitpod CSWSH issue from 2023 caused by insufficient origin validation ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)).
- Persistent-connection abuse is common in practice because it is cheap for attackers to hold many sockets open and drip traffic. That maps directly to:
  - connection exhaustion
  - oversized-frame abuse
  - subscription churn/flooding
  - slow-reader / slow-writer backpressure attacks

#### Less common but still real

- Token replay matters if auth tokens are leaked through logs, browser storage, query params, or compromised clients.
- Subscription enumeration matters if attackers can probe document IDs and distinguish forbidden vs nonexistent states at scale.
- Message schema abuse matters because WebSocket traffic often bypasses the richer validation/logging stacks people already built for HTTP.

#### Meridian-specific reading

- Meridian authenticates with JWT in the first message rather than cookies, which lowers classic cookie-based CSWSH risk, but it does **not** remove the need for origin validation.
- If an attacker can steal or reuse the token, origin-blind upgrades still help them.
- Meridian should care most about:
  - origin allowlisting on handshake
  - short auth timeout
  - per-user/per-IP connection caps
  - per-connection doc subscribe/unsubscribe rate limits
  - structured oversize rejection
  - doc-level authorization on every message, not only at subscribe time
  - operational telemetry for rejected frames and auth failures

### 4. Real-world Yjs/CRDT failure modes

#### What breaks in production more often than "CRDT corruption"

- **Lifecycle and integration bugs**
  - duplicate Yjs imports are a known real-world footgun; Yjs warns they "will lead to issues" and may break constructor checks inside the CRDT algorithm ([Yjs issue #438](https://github.com/yjs/yjs/issues/438))
  - Liveblocks calls duplicate Yjs imports "one of the most common issues" and ties them to synchronization problems ([Liveblocks Yjs best practices](https://liveblocks.io/docs/guides/yjs-best-practices-and-tips))
- **Intermediate-state surprises**
  - Yjs issue #591 shows misordered updates can temporarily hide `Y.Map` keys even though the docs later converge again ([Yjs issue #591](https://github.com/yjs/yjs/issues/591))
  - that means "eventual convergence" is not enough if your app assumes every intermediate read is safe
- **Sync timing assumptions**
  - `y-websocket` issue #81 reports `'sync'` being observed before the document is actually available, producing intermittent empty reads ([y-websocket issue #81](https://github.com/yjs/y-websocket/issues/81))
- **Reconnect/reload edge cases**
  - Hocuspocus issue #344 reports backend restart + reconnect appending duplicated content into the editor ([Hocuspocus issue #344](https://github.com/ueberdosis/hocuspocus/issues/344))
- **Unload/leak problems**
  - Hocuspocus issue #846 reports unloaded-doc lifecycle problems where servers "slowly accumulat[e] loaded documents" ([Hocuspocus issue #846](https://github.com/ueberdosis/hocuspocus/issues/846))

#### What larger products publicly signal

- Figma's public multiplayer write-up emphasizes eventual consistency and choosing simple algorithms that are easier to reason about and keep stable in production ([Figma: Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)).
- Notion's help docs say many people can edit the same page at once and that "the most recent change will be reflected on the page" for same-block editing ([Notion help](https://www.notion.com/help/collaborate-within-a-workspace)).
- Liveblocks explicitly warns against unnecessary Yjs subdocuments and against duplicate Yjs imports, which is another way of saying that production pain is often in system boundaries, not in the abstract CRDT math ([Liveblocks Yjs best practices](https://liveblocks.io/docs/guides/yjs-best-practices-and-tips)).

#### Meridian implication

- Meridian should worry much more about:
  - stale in-memory vs persisted state
  - restore/bootstrap timing
  - duplicate library/runtime assumptions
  - reconnect duplication
  - misrouted multiplexed responses
  - GC/unload behavior for idle docs
- Meridian should worry less about "CRDTs mathematically failing under normal text editing."

### 5. Traffic patterns for writing platforms specifically

#### Writer behavior is different from design-tool behavior

- Fiction writers usually spend long sessions in a single chapter, with occasional jumps to notes, prior chapters, outline docs, character sheets, and continuity references.
- Scrivener's workflow makes this explicit:
  - chapter-to-chapter reference jumps
  - sequential reading across many chapter/scene docs
  - arbitrary multi-doc selections for proofing and POV-specific passes ([Scrivenings article](https://www.literatureandlatte.com/blog/view-and-edit-multiple-documents-with-scrivenings))

#### Chapter/document sizes

- Royal Road community threads are not formal benchmarks, but they are useful directional evidence for web-serial norms:
  - many authors report chapters around 1.5k-3k words
  - 2k-4k is common
  - 5k+ happens, but is often treated as "long for web"
  - some progression-fantasy/web-serial works run hundreds to over a thousand chapters ([Royal Road discussion 1](https://www.royalroad.com/forums/post/1519715), [discussion 2](https://www.royalroad.com/forums/thread/140096), [discussion 3](https://www.royalroad.com/forums/thread/146572))
- That means Meridian should expect:
  - many medium documents, not one giant document
  - projects with aggregate size far larger than any single chapter
  - occasional large docs for outlines, omnibus drafts, or merged proof passes

#### Practical traffic pattern for Meridian

- Common:
  - one writer
  - one active chapter
  - long quiet editing sessions
  - tiny steady update stream
- Normal bursts:
  - paste a few paragraphs
  - accept an AI proposal that touches many ranges
  - open a chapter after being offline
  - switch between chapter, outline, and notes
- Less common but important:
  - import a big manuscript
  - run an AI-assisted rewrite across a whole chapter
  - preview many chapters in quick succession
- Rare:
  - multiple humans actively editing the same chapter at the same time for long periods

#### Meridian implication

- Human-human concurrency is likely lower than in Figma/Notion-style workplace tools.
- Human+AI overlap is likely higher.
- Meridian should optimize for:
  - long-lived single-user sessions
  - robust reconnect after tab sleep/network changes
  - safe coexistence of editor traffic and AI proposal traffic
  - fast chapter switching without maintaining huge numbers of live subscriptions

### 6. Production reliability benchmarks

#### Public benchmarks from realtime vendors

- Ably advertises:
  - `<30ms` round-trip latency within a datacenter at p99
  - `<65ms` global round-trip latency at p99
  - 99.999% global service availability
  - automatic connection recovery with continuity if re-established within two minutes ([Ably architecture overview](https://ably.com/docs/platform/architecture))
- Liveblocks exposes explicit UX-level reconnect timing:
  - auto-reconnect is expected to be quick
  - `lostConnectionTimeout` defaults to 5 seconds and can be configured from 1s to 30s ([Liveblocks client API](https://liveblocks.io/docs/api-reference/liveblocks-client))

#### What these benchmarks mean for Meridian

- Meridian does **not** need Ably-grade infrastructure numbers to ship a good writer product.
- Meridian **does** need equivalent user-facing guarantees:
  - normal reconnects should usually be invisible
  - after ~5 seconds, show a clear reconnecting/lost-connection state
  - preserve continuity across short disconnects
  - never silently drop accepted edits
  - if continuity cannot be guaranteed, force a fresh state-vector/snapshot resync

#### Suggested practical targets

- p95 local edit echo: under 100 ms
- p99 local edit echo: under 250 ms
- presence/awareness freshness: under 5 s to degrade gracefully
- reconnect UX:
  - silent recovery for short blips
  - visible warning after 5 s
  - continuity window at least tens of seconds; 2 minutes is a strong target if session history/state vectors support it
- app-level message loss target:
  - effectively zero durable edit loss
  - transport may disconnect, but accepted edits must either persist or be explicitly retried/rejected

## Common vs Theoretical Summary

### Common

- small Yjs incremental updates
- long-lived sessions with intermittent reconnects
- 1-3 active docs, sometimes 4-8
- chapter switching and reference hops
- duplicate-import and lifecycle bugs
- reconnect timing edge cases
- auth/origin mistakes
- flood/oversize abuse

### Realistic but exceptional

- 1 MB WebSocket payloads
- full-document syncs above 1 MB
- import/replay/bootstrap paths that need chunking or HTTP fallback
- bursts of subscription churn during review/search/navigation

### Mostly theoretical or architecture-smell

- steady-state 10 MB incremental edit frames from normal writers
- dozens of concurrently hot subscriptions for one writer session
- "CRDT math corruption" as the primary production risk

## Alternative Approaches

### Approach 1: Keep very tight limits everywhere

Description:
- Keep the current 64 KiB WebSocket cap and reject anything larger.

Pros:
- Simple to reason about
- Strong abuse resistance
- Low memory pressure

Cons:
- Legitimate bootstrap/paste/import cases will fail
- Encourages opaque EOF-style failures unless error handling is excellent
- Pushes product bugs into "random sync instability"

Codebase fit:
- Fits the current implementation, but probably too brittle for Meridian's long-form writing and AI-assisted workflows.

### Approach 2: Two-lane transport

Description:
- Keep WebSocket optimized for small incremental diffs.
- Move large state transfer to chunking, snapshot fetch, or HTTP fallback.

Pros:
- Matches how vendors like Liveblocks handle oversize messages
- Keeps the fast path small and safe
- Gives a clean answer for initial sync/import/huge proposal cases

Cons:
- More protocol complexity
- Requires explicit resync/bootstrap design

Codebase fit:
- Best fit. Meridian already distinguishes between runtime state, snapshots, and proposal payloads, so there is a natural place to separate "interactive diff traffic" from "large state transfer."

### Approach 3: Allow very large WebSocket frames and rely on infrastructure

Description:
- Raise limits substantially and let the existing multiplexed channel carry everything.

Pros:
- Minimal protocol branching
- Fastest to prototype

Cons:
- Easier to abuse
- More likely to produce head-of-line blocking, GC spikes, and per-connection memory blowups
- Harder to make multi-doc routing and fairness robust

Codebase fit:
- Poor fit for Meridian's current socket architecture and current known multi-doc routing issues.

## Recommendation

Meridian should optimize for **many small updates, occasional medium/large bootstrap operations, and frequent reconnect/reopen events**, not for gigantic steady-state frames.

Recommended posture:

1. Treat `64 KiB` as too low for the whole system, but keep the spirit of a small fast path.
2. Keep WebSocket for normal incremental Yjs traffic and awareness.
3. Add a deliberate large-payload path for initial sync/import/replay/snapshot transfer.
4. Never kill the entire socket on an oversized frame without first trying to return a structured error.
5. Keep the 10-doc subscription cap unless product evidence proves otherwise, but make sure search/navigation do not depend on live subscriptions.
6. Prioritize lifecycle correctness over algorithm novelty:
   - restore/snapshot coherence
   - reconnect duplication safety
   - multiplex routing correctness
   - duplicate-Yjs prevention
   - origin/auth hardening

If Meridian does only a few things next, the highest-value ones are:

- graceful oversize handling
- origin validation
- rock-solid multi-doc routing
- explicit resync path after reconnect or restore
- telemetry for frame size, reconnect rate, subscribe churn, and doc load/unload behavior

## Open Questions

1. What are Meridian's actual chapter/document size distributions once real writer projects are loaded?
2. Will AI proposal acceptance often generate large batched updates against full chapters?
3. Should large chapter import/open use HTTP snapshot fetch before entering incremental WebSocket sync?
4. Does Meridian want one socket per project, or would one socket per active document simplify routing/failure isolation enough to justify the tradeoff?
5. How should Meridian surface "reconnecting", "desynced", and "force refresh required" states in the editor UX?

## Sources

- Yjs document updates: https://docs.yjs.dev/api/document-updates
- Kevin Jahns, "Are CRDTs suitable for shared editing?": https://blog.kevinjahns.de/are-crdts-suitable-for-shared-editing
- Liveblocks changelog, week 6 2025: https://liveblocks.io/changelog/week-6-2025
- Liveblocks client API: https://liveblocks.io/docs/api-reference/liveblocks-client
- Liveblocks Yjs best practices: https://liveblocks.io/docs/guides/yjs-best-practices-and-tips
- OWASP WebSocket Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- PortSwigger Academy, cross-site WebSocket hijacking: https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking
- Ably architecture overview: https://ably.com/docs/platform/architecture
- Figma, "Realtime editing of ordered sequences": https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- Notion help, collaborate in a workspace: https://www.notion.com/help/collaborate-within-a-workspace
- Yjs issue #438: https://github.com/yjs/yjs/issues/438
- Yjs issue #591: https://github.com/yjs/yjs/issues/591
- y-websocket issue #81: https://github.com/yjs/y-websocket/issues/81
- Hocuspocus issue #344: https://github.com/ueberdosis/hocuspocus/issues/344
- Hocuspocus issue #846: https://github.com/ueberdosis/hocuspocus/issues/846
- Scrivener / Literature & Latte, Scrivenings: https://www.literatureandlatte.com/blog/view-and-edit-multiple-documents-with-scrivenings
- Royal Road discussion on chapter length: https://www.royalroad.com/forums/post/1519715
- Royal Road discussion on chapter length: https://www.royalroad.com/forums/thread/140096
- Royal Road discussion on web serials to books: https://www.royalroad.com/forums/thread/146572
