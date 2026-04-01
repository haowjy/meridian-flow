# Unified Terminate + Atomic Stream Switch Research (2026-03-28)

## Scope
Research question: are (1) single-path/idempotent termination and (2) atomic resource transfer during replacement common in production systems?

## Executive Summary
- A **single termination path** is a very common production pattern. It appears as lifecycle callbacks (`terminate/2`, `PostStop`), centralized shutdown APIs (`http.Server.Shutdown`, `gRPC GracefulStop`), and explicit drain methods (`NATS Drain`).
- **Atomic replacement with resource inheritance** is common mainly at the **accept/listener layer** (systemd socket activation, Envoy/NGINX/HAProxy reload techniques), but much less common for **in-flight request/stream state transfer**.
- Production systems more often choose: **inherit admission resource** + **drain old in-flight work**, rather than full in-flight migration.
- Recommended design for your service:
  1. Implement a single `Terminate(reason, cause)` with `sync.Once` + strict phase ordering.
  2. Implement stream switch as **atomic slot lease transfer** (old stream keeps execution state until stopped; new stream inherits quota slot only).
  3. Do not try to migrate in-flight LLM generation state across executors.

## Q1) Is unified Terminate common?

### Go servers (gRPC, HTTP, websocket-style)
- `net/http` centralizes graceful shutdown in `Server.Shutdown`: close listeners, close idle conns, wait for active conns to become idle; `RegisterOnShutdown` is the single hook for long-lived/hijacked protocols.
- `grpc-go` exposes `GracefulStop` as a single termination entry point that blocks until pending RPCs finish.
- gRPC graceful shutdown docs emphasize a unified sequence: stop accepting new RPCs, let in-flight complete, then force-stop if timeout.
- NATS clients provide `Drain()` to unify draining + close while preserving in-flight work semantics.
- Gorilla websocket chat example uses paired goroutines with central unregister/close flow (hub unregister path) to avoid scattered teardown.

### Actor systems
- Erlang/OTP `gen_server` has `terminate(Reason, State)` callback for process shutdown cleanup.
- Elixir `GenServer` provides `terminate/2`, but docs explicitly note it is not guaranteed in all crash scenarios unless process is trapping exits; this is a key production caveat.
- Akka typed lifecycle uses `PostStop`/`PreRestart` signals for cleanup and restart transitions.

### Database pool analogs
- Pool designs are built around a single return/cleanup path (`close()` on wrapper returns to pool; pool enforces max size and timeout).
- Go `database/sql` APIs rely on explicit close/release semantics; misuse leaks scarce slots.
- PgBouncer documentation highlights session-state pitfalls when multiplexing (transaction pooling), showing why cleanup/reset must be centralized and explicit.

### Kubernetes lifecycle
- Pod shutdown is strongly lifecycle-driven: SIGTERM + grace period + forced kill, with lifecycle hooks.
- Docs highlight that ordering/timing details can be non-deterministic in some lifecycle handling, reinforcing the need for idempotent termination logic.

### Takeaway
Yes, unified termination is a standard production pattern; distributed cleanup across many call sites is a known source of leaks, double-accounting, and inconsistent state.

## Q2) Is atomic resource transfer during replacement common?

### Common at listener/admission layer
- **systemd socket activation**: listening sockets are preserved/passed to the new process, minimizing dropped accepts.
- **Envoy hot restart**: listener sockets are passed to new process; old process drains existing connections.
- **NGINX reload**: new workers start with new config; old workers stop accepting and continue serving existing clients.
- **HAProxy seamless reload patterns** also rely on shared/inherited listeners to avoid acceptance gaps.

### Not common for in-flight stream state migration
- Envoy docs explicitly: existing connections are **not transferred** to new process; they drain/terminate.
- HTTP/2 GOAWAY semantics support graceful drain and retry behavior, not transparent migration of in-flight stream execution state.
- DB systems generally do not transfer active transaction/session state between arbitrary live connections safely.

### Takeaway
Atomic transfer is common for **scarce admission resources** (ports/listener slots/quota tokens), but uncommon for arbitrary in-flight execution state.

## Q3) Anti-patterns to avoid
- Multi-exit cleanup branches (some paths forget billing settlement, registry deregistration, or slot release).
- Non-idempotent terminate path (double finalization, double billing, double release).
- Assuming termination callback always runs (actor/process crash caveats).
- Replacement flow that allocates new slot before old one releases (N+1 pressure/spikes).
- Coupling switch-over with full state transfer requirements (fragile race-heavy design).
- Blocking inside cleanup without deadlines/timeouts.
- Missing generation/fencing checks (old stream events arriving after switch and mutating new stream state).
- Assuming cancellation completion is synchronous (`context.AfterFunc` stop function does not wait for callback completion).

## Q4) Go-specific patterns/libraries
- `sync.Once` for idempotent `Terminate`.
- `context.WithCancelCause` to preserve cancellation reason propagation.
- `context.AfterFunc` for attaching cleanup triggers to context cancellation (with explicit race handling).
- `errgroup.WithContext` for grouped goroutine cancellation and structured wait.
- `golang.org/x/sync/semaphore` or explicit slot-lease structs for quota/slot accounting.
- `oklog/run` and `tomb` are practical lifecycle helpers for goroutine start/interrupt/wait orchestration.
- `http.Server.RegisterOnShutdown` pattern: central registration point for protocol-specific tear-down.

## Recommendation for Your Two Fixes

### 1) Unified `Terminate(reason)`
Implement one idempotent method on stream executor with explicit ordered phases:
1. Fence executor (`terminated=true`, record reason/cause, increment generation).
2. Stop external ingress/egress (detach callbacks, stop writes/events).
3. Finalize accounting exactly once (token finalization + billing settlement).
4. Publish terminal status once.
5. Release resources (`slot.Release()` or `slot.TransferTo(next)` path).
6. Run deferred hooks/metrics.

Hard requirements:
- Idempotent under concurrent calls.
- Deadline-bounded internal steps.
- Safe if called from any termination reason (complete/cancel/error/exhaustion/switch).

### 2) Atomic stream switch with slot transfer
Implement as **lease transfer**, not full stream-state migration:
- Old stream owns `SlotLease{slotID, epoch, ownerStreamID}`.
- On switch request, compare-and-swap ownership to new stream atomically (`owner=next`, `epoch++`).
- New stream starts immediately under inherited lease.
- Old stream receives cancel/terminate and drains; late events rejected via epoch mismatch.

This mirrors proven hot-restart/drain patterns: transfer admission resource, drain old work, avoid in-flight state teleportation.

## Sources
- Go `net/http` server shutdown semantics: https://go.dev/src/net/http/server.go
- Go `context` package (`AfterFunc`, cancellation notes): https://pkg.go.dev/context
- `errgroup` docs: https://pkg.go.dev/golang.org/x/sync/errgroup
- `grpc-go` package docs (`GracefulStop`): https://pkg.go.dev/google.golang.org/grpc
- gRPC graceful shutdown guide: https://grpc.io/docs/guides/server-graceful-stop/
- NATS drain semantics: https://docs.nats.io/using-nats/developer/receiving/drain
- Gorilla websocket chat example: https://pkg.go.dev/github.com/gorilla/websocket/examples/chat
- Erlang `gen_server` terminate callback: https://www.erlang.org/doc/apps/stdlib/gen_server.html
- Elixir `GenServer` terminate caveats: https://hexdocs.pm/elixir/GenServer.html
- Akka typed actor lifecycle (`PostStop`, restart lifecycle): https://doc.akka.io/libraries/akka-core/current/typed/actor-lifecycle.html
- Kubernetes Pod lifecycle and termination behavior: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- systemd socket units and FD passing: https://man7.org/linux/man-pages/man5/systemd.socket.5.html
- daemon lifecycle/socket activation rationale: https://man7.org/linux/man-pages/man7/daemon.7.html
- Envoy hot restart behavior: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/hot_restart
- NGINX signal-based reload/drain behavior: https://nginx.org/en/docs/control.html
- HTTP/2 GOAWAY semantics (RFC 9113): https://datatracker.ietf.org/doc/html/rfc9113
- PgBouncer behavior and pooling-mode caveats: https://www.pgbouncer.org/features.html and https://www.pgbouncer.org/config
- HikariCP operational guidance: https://github.com/brettwooldridge/HikariCP
- oklog/run lifecycle helper: https://github.com/oklog/run
- tomb goroutine lifecycle helper: https://pkg.go.dev/gopkg.in/tomb.v2
