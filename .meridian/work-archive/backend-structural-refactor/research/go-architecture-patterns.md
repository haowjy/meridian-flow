# Go Backend Architecture Patterns (2026) for Meridian

Date: 2026-03-21
Scope: Production Go backend architecture patterns for Meridian domains (documents, real-time collaboration/Yjs, SSE streaming, billing, and upcoming work-items/agents/tools).

## Sources Used

Official/primary guidance:
- Go Code Review Comments (interfaces): https://go.dev/wiki/CodeReviewComments
- Effective Go (interface naming/composition): https://go.dev/doc/effective_go
- Go blog: package names: https://go.dev/blog/package-names
- Organizing a Go module (official layout guidance): https://go.dev/doc/modules/layout
- `net/http` graceful shutdown docs: https://pkg.go.dev/net/http#Server.Shutdown
- `os/signal.NotifyContext`: https://pkg.go.dev/os/signal#NotifyContext
- `errgroup`: https://pkg.go.dev/golang.org/x/sync/errgroup
- `plugin` warnings in stdlib: https://pkg.go.dev/plugin

Production project examples:
- Kubernetes `kube-apiserver` options/completion/validation flow:
  - https://raw.githubusercontent.com/kubernetes/kubernetes/master/cmd/kube-apiserver/app/options/options.go
  - https://raw.githubusercontent.com/kubernetes/kubernetes/master/cmd/kube-apiserver/app/server.go
- Kubernetes/controller-runtime scheme builder (`AddToScheme` composition): https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/scheme
- HashiCorp `go-plugin` (RPC plugin architecture): https://github.com/hashicorp/go-plugin
- HashiCorp Consul runtime config struct: https://raw.githubusercontent.com/hashicorp/consul/main/agent/config/runtime.go
- CockroachDB server config (typed config structs): https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/server/config.go
- Grafana settings/config central struct (plus migration toward config provider): https://raw.githubusercontent.com/grafana/grafana/main/pkg/setting/setting.go
- Uber Fx (parameter structs, lifecycle hooks): https://pkg.go.dev/go.uber.org/fx

Community-contentious references:
- `golang-standards/project-layout` README (explicitly not official): https://github.com/golang-standards/project-layout
- Russ Cox issue clarifying it is not standard: https://github.com/golang-standards/project-layout/issues/117
- Google Wire archive status: https://github.com/google/wire

---

## Executive Summary for Meridian

1. Keep Clean/Hexagonal intent, but rename `domain/services` to `domain/ports` (or `domain/contracts`) to reduce confusion.
2. Replace long positional constructors with a dependency struct (`Deps` / `Params`) and optional functional options only for true optional behavior.
3. Break `cmd/server/main.go` into boot modules under `internal/app` (config, infra, domains, http, workers) with a small composition root.
4. Split oversized interfaces by use-case, define them in consumer packages, and use composite interfaces only at wiring boundaries.
5. Move from flat config to nested domain configs + explicit `Validate()` + `CompleteDefaults()` pipeline.
6. Standardize lifecycle: root context from `signal.NotifyContext`, `errgroup.WithContext` for background workers, `http.Server.Shutdown` timeout path.
7. Naming: prefer explicit domain names (`repository` vs `store`) and consistency over ideology.
8. For upcoming domains (work-items, agents, tools), adopt module registration pattern: each domain exposes `Module`/`Register` entrypoint so adding a domain is mostly additive.

---

## 1) `domain/services/` Naming for Interfaces

### What the ecosystem says
- Go official guidance says interfaces usually belong in the package that **uses** them, not where they’re implemented.
- The term “service” in Go projects usually implies concrete logic, so `domain/services` for interfaces is easy to misread.
- Hexagonal terminology uses “ports,” and many teams use that label specifically to disambiguate interfaces from implementations.

### Consensus vs contention
- Consensus: avoid ambiguous names; package names should communicate purpose quickly.
- Contentious: whether interface packages should be centralized at all (many Go teams prefer local consumer-side interfaces).

### Options and tradeoffs
- Keep `domain/services/` + docs
  - Pros: no rename churn.
  - Cons: recurring confusion remains; docs won’t fully prevent misreads.
- Rename to `domain/interfaces/`
  - Pros: explicit.
  - Cons: Go style generally avoids generic/technical package names when domain names are possible.
- Rename to `domain/contracts/`
  - Pros: clear that these are abstractions.
  - Cons: less common term in Go than `ports`.
- Rename to `domain/ports/` (recommended)
  - Pros: aligns with hexagonal vocabulary, strongly signals non-implementation.
  - Cons: requires team buy-in on hexagonal terms.
- Flatten interfaces into consumer packages
  - Pros: most Go-idiomatic per CodeReviewComments; tight interfaces.
  - Cons: harder when you intentionally enforce architecture boundaries at scale.

### Recommendation for Meridian
- For this codebase size and architecture style, use `domain/ports/<domain>` and `internal/service/<domain>`.
- Add a short package doc in each `ports` package: “Port interfaces consumed by use-cases.”

When to use:
- You intentionally maintain clear architecture boundaries.

When to avoid:
- Small packages with one consumer where local interface definition is simpler.

---

## 2) Constructor Explosion (27 Parameters)

### What large projects and tooling do
- Kubernetes pattern: use typed options/config structs with `Complete()` + `Validate()` instead of giant positional constructors.
- Fx explicitly documents constructor readability problems and recommends parameter structs.
- Production codebases commonly use one of:
  1. `Params/Deps` struct (most common)
  2. Functional options for optional behavior
  3. Both together

### Pattern tradeoffs
- Dependency struct (`type Deps struct { ... }`) (recommended baseline)
  - Pros: readable callsites, named fields, no parameter order bugs, easy refactor.
  - Cons: can become “god struct” if not scoped per component.
- Functional options (`WithLogger`, `WithRetry`) for optional tuning
  - Pros: extend constructor API without breaking callers; good for optional concerns.
  - Cons: harder to validate globally; can obscure required deps if overused.
- Builder pattern
  - Pros: useful for staged construction with many conditional branches.
  - Cons: often unidiomatic overhead in Go for simple services.

### Recommendation for Meridian
- Convert each large service constructor to:
  - `NewX(deps XDeps, opts ...XOption)`
  - `XDeps` contains required collaborators.
  - `XOption` only for optional/tuning knobs.
- Enforce required fields via `deps.Validate()` in constructor.

Use when:
- Constructor has >~7 collaborators or has frequent reorder mistakes.

Avoid when:
- Small, stable constructors with 2-4 required dependencies.

---

## 3) `main.go` Decomposition (614-line DI Wiring)

### What production Go services do
- Official Go guidance: keep server logic in `internal`, entrypoints under `cmd`.
- Kubernetes style: command/options/config/run are separated; main command function is orchestration, not all implementation.
- Many teams keep DI framework-free and split wiring into plain packages/functions.

### DI framework reality in 2026
- `google/wire` is archived and marked no longer maintained (archived Aug 25, 2025).
- `uber/fx` is active and battle-tested, with lifecycle primitives and module-oriented DI.
- Plain Go composition remains the most common and easiest to debug.

### Options and tradeoffs
- Plain function decomposition under `internal/app` (recommended)
  - Pros: idiomatic, transparent, easy debugging, minimal framework lock-in.
  - Cons: some boilerplate in wiring.
- Fx
  - Pros: strong lifecycle management, module composition, scales well for many domains.
  - Cons: adds framework mental model and DI indirection.
- Wire
  - Pros: compile-time graph validation.
  - Cons: no longer maintained; poor choice for new strategic adoption.

### Recommendation for Meridian
Create `internal/app` with explicit bootstrap stages:
- `internal/app/config`
- `internal/app/infra` (db, redis, yjs infra clients, llm clients)
- `internal/app/domains` (document/collab/billing/workitems/agents/tools)
- `internal/app/http` (router + handlers)
- `internal/app/workers` (background loops)
- `internal/app/bootstrap` (composition root)

Keep `cmd/server/main.go` to startup orchestration only.

---

## 4) Interface Organization (Too Many Interfaces + Fat Repository)

### Go guidance
- Interfaces should be defined where consumed.
- Do not predefine interfaces before usage is clear.
- Prefer smaller interfaces; compose when needed (`io.ReadWriter` style).

### Practical heuristics
- 1-3 methods is typical for “behavior interfaces.”
- 8-12 methods often indicates mixed responsibilities (query + write + admin + transactions in one contract).
- Large interfaces are acceptable only at very stable subsystem boundaries.

### Composite interfaces
- Useful as migration/wiring façade:
  - `type DocumentStore interface { DocumentReader; DocumentWriter; DocumentTxn }`
- Keep sub-interfaces primary; composite used at edges.

### Recommendation for Meridian
- Split 12-method `DocumentRepository` by use-case direction:
  - `DocumentReader`
  - `DocumentWriter`
  - `DocumentVersionStore` (if needed)
  - `DocumentTx` (if needed)
- Keep consumer-side narrow interfaces in application/use-case packages.
- Keep adapter implementation concrete in `internal/repository/postgres/...`.

Use when:
- Different handlers/services consume disjoint method subsets.

Avoid when:
- You truly have one cohesive transaction script requiring all methods together.

---

## 5) Config Patterns (47 Flat Fields, No Validation)

### What production code does
- Consul and Cockroach use typed config structs (often large) with strong typing and domain grouping.
- Kubernetes options pattern uses `Complete()` and `Validate()` lifecycle before run.
- Grafana shows a large config surface but also explicit movement toward provider abstraction.

### Pattern tradeoffs
- Flat struct
  - Pros: simple env wiring.
  - Cons: poor discoverability, weak ownership boundaries, easy invalid combinations.
- Nested sub-structs by domain (recommended)
  - Pros: ownership, readability, easier docs/testing.
  - Cons: slightly more initial boilerplate.
- Validation style
  - Struct tags/third-party validators: quick but limited for cross-field invariants.
  - Explicit `Validate()` methods: verbose but best for domain rules and actionable errors.

### Recommendation for Meridian
Adopt config pipeline:
1. Load raw config (env/file).
2. `CompleteDefaults()` to fill derived defaults.
3. `Validate()` hard-fail on invalid values.

Use nested groups:
- `HTTP`, `DB`, `Realtime`, `LLM`, `Billing`, `Agents`, `Tools`, `Observability`.

---

## 6) Background Worker Lifecycle + Graceful Shutdown

### Go baseline patterns
- Root cancel context from `signal.NotifyContext`.
- Stop HTTP with `Server.Shutdown(ctx)`.
- Run workers under `errgroup.WithContext` so one failure can cancel peers.

### Recommendation for Meridian
- Ban `context.Background()` in long-lived worker starts (except at top-level bootstrap before deriving cancellable context).
- Standard app lifecycle:
  1. `ctx, stop := signal.NotifyContext(...)`
  2. `g, gctx := errgroup.WithContext(ctx)`
  3. Start HTTP server + workers using `gctx`
  4. On signal: stop intake, call `Shutdown(timeoutCtx)`
  5. `g.Wait()` and exit with first error

Use `SetLimit` on errgroup for bounded fan-out where relevant.

When to use manual goroutine management:
- Short-lived fire-and-forget operations tightly scoped to request context.

---

## 7) Naming Conventions (`Store` vs `Repository`, packages, mocks, aliases)

### Community reality
- Go has strong package naming guidance, but no global mandate for `Store` vs `Repository`.
- Large projects vary (`store`, `storage`, `repo`, domain-specific nouns). Consistency within one codebase matters most.

### Practical guidance for Meridian
- `Repository` for domain persistence abstraction at use-case boundary.
- `Store` for lower-level KV/cache/state abstractions.
- Avoid `Repo` abbreviation in exported types unless already pervasive.

Package naming:
- Prefer domain names (`billing`, `collab`, `documents`) over technical buckets (`interfaces`, `util`, `common`).
- Keep package names lowercase and concise; avoid redundancy with exported symbol names.

Mocks/test doubles:
- Consumer-side fakes: `fakeDocumentRepo`, `stubCreditLedger` in `_test.go`.
- Generated mocks named after interface (`MockDocumentReader`) only where generation is already standard.

Import aliases:
- Only when collisions/uninformative names require it; use clear aliases (Google style recommends `urlpkg`-style where needed).

---

## 8) Extensibility for New Domains (Work Items, Agents, Tools)

### Patterns that scale in Go
- Domain module registration pattern (recommended): each domain exports one bootstrap function that wires repos/services/handlers/workers.
- Registry/builder composition pattern (Kubernetes `AddToScheme` style).
- Plugin architecture:
  - In-process Go `plugin` package has major portability/build drawbacks.
  - RPC subprocess plugins (`hashicorp/go-plugin`) are production-proven for stronger isolation/extensibility.

### Recommendation for Meridian
For near-term (same binary):
- Add per-domain `Module` with explicit registration hooks:
  - `RegisterHTTP(router)`
  - `RegisterWorkers(group)`
  - `RegisterTools(registry)`
- Compose modules in one place (`internal/app/domains/register.go`).
- Rule: adding a domain should mostly mean adding a new package + one registration line.

For agent/tool execution medium-term:
- Prefer RPC-isolated tool runners for untrusted/unstable tools.
- Avoid Go `plugin` for cross-platform production path.

---

## Community Consensus vs Contentious Topics

### Strong consensus
- Consumer-side, minimal interfaces.
- Clear package names; avoid `util/common/interfaces` buckets.
- Small composition root with most code in `internal` packages.
- Explicit lifecycle and graceful shutdown.

### Contentious / context-dependent
- Whether to centralize interfaces in dedicated architecture-layer packages.
- Functional options vs plain config/deps structs (many teams use both).
- DI framework adoption (Fx helpful at scale, but plain Go remains idiomatic default).
- Exact terminology (`service`, `port`, `contract`, `repository`, `store`).

---

## Meridian-Specific Target Shape (Pragmatic)

### Short-term (high ROI)
1. Rename `domain/services` -> `domain/ports`.
2. Refactor worst constructor(s) to `Deps` struct + optional options.
3. Split `main.go` into `internal/app/*` bootstrap packages.
4. Introduce root lifecycle manager (`NotifyContext` + `errgroup`).
5. Add config `Validate()` and start rejecting invalid startup config.

### Medium-term
1. Split fat repository interfaces by use-case.
2. Add domain module registration boundaries.
3. Introduce explicit worker manager abstraction for domain workers.

### Avoid for now
- Full DI framework migration unless plain wiring continues to create significant friction.
- In-process Go plugins for agent tools.

---

## Final Recommendation

For Meridian’s size and roadmap, the most Go-idiomatic and lowest-risk direction is:
- Keep explicit wiring (no forced DI framework),
- tighten naming (`ports` + domain-first packages),
- move to `Deps` structs + validated nested config,
- adopt one lifecycle model for HTTP + workers,
- and enforce domain module registration so new domains are additive.

This balances current velocity with production readiness and future extensibility for agents/tools.
