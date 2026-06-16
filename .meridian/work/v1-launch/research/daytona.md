# Daytona Research for Meridian Flow Work-Item Sandboxes

Date: 2026-03-19

## Executive summary

Daytona is a hosted sandbox orchestration platform for running agent code in isolated Linux environments with filesystem/process/network access and SDK/API control.

For Meridian Flow, Daytona is a viable option if you want:
- Real shell + tool parity for advanced agent workflows
- Snapshot-based warm starts
- Centralized sandbox lifecycle and quotas

But for a writing-first product, per-work-item always-on sandboxes are likely overkill unless your near-term roadmap includes heavy code-like tooling, browser automation, or complex multi-process pipelines.

Recommendation:
- Start with **on-demand sandboxes per active thread/task** (not one long-running sandbox per work item).
- Use snapshot + auto-stop + archive aggressively.
- Keep document storage authoritative in Postgres/Supabase; use sandbox FS as an execution cache/workspace.
- Re-evaluate always-on per-work-item environments after measuring real agent tool usage.

## 1) What Daytona is and how it works

Daytona exposes "sandboxes" as programmable Linux environments. Its platform architecture is split into:
- Interface plane (SDKs, CLI, dashboard, MCP, SSH)
- Control plane (API, proxy, snapshot builder, sandbox manager)
- Compute plane (runners, sandbox daemon/toolbox, snapshot store, volumes)

Key architecture details from Daytona docs:
- API is NestJS + Redis + PostgreSQL + OIDC/Auth0 integration and org-scoped multi-tenancy.
- Sandboxes are scheduled onto runners.
- Sandboxes are isolated with Linux namespaces and dedicated CPU/RAM/disk allocation per sandbox.
- Snapshot store is OCI-based with S3-compatible object storage backend.

Notable implication:
- Isolation is container-style namespace isolation (with Sysbox referenced in Daytona changelog), not Firecracker-style hardware microVM isolation.

## 2) SDK/API: create/manage/destroy environments

Daytona supports SDKs for Python, TypeScript, Ruby, and Go, plus REST API/CLI.

Core lifecycle operations available:
- Create sandbox (`daytona.create()` / `POST /api/sandbox`)
- Start/stop/delete/archive/recover
- Resize CPU/memory/disk
- Create from snapshots/images
- Snapshot CRUD and activation

Toolbox API supports:
- Process execution (sync + PTY sessions)
- File operations
- Git operations
- LSP endpoints
- Computer use/browser automation endpoints

Operational controls available:
- Auto-stop interval (default 15 minutes inactivity; can set 0 to disable)
- Webhooks for sandbox/snapshot events
- Preview URL/token model for exposed services
- API key scopes and org-level permissions
- Audit logs with actor, action, target, IP/user-agent metadata

## 3) Projecting Meridian virtual doc tree into Daytona FS + syncing back

### Design goal

Keep Supabase/Postgres document tree as source of truth; treat sandbox filesystem as execution workspace.

### Recommended sync model

1. Materialize work-item view into sandbox
- Backend creates sandbox from a prebuilt Meridian snapshot.
- Fetch relevant docs from DB (entire work item scope or lazy subset).
- Write them under deterministic paths in sandbox (`/workspace/...`).
- Include metadata manifest (`.meridian-sync/manifest.json`) with doc IDs, content hashes, revision versions.

2. Agent runs tools in sandbox
- Agents use shell/tools directly against local files.
- Capture changed-file list via Git status or fs diff against manifest.

3. Incremental sync-back
- On checkpoint, task completion, or periodic timer:
  - Read changed files only.
  - Compare hash/revision to DB head.
  - Apply optimistic concurrency (reject if base revision stale).
  - Persist merged content to document tree and emit events.

4. Conflict strategy
- If DB changed while sandbox edited:
  - Attempt structured/text merge for markdown/text.
  - If conflict remains, create a conflict artifact in work item and require user/agent resolution.

5. Lifecycle
- Inactive sandbox -> stop (retain disk quota only)
- Long idle -> archive (free quota)
- Resume from archive/recover when user re-enters task

### Implementation notes for Meridian

Backend (Go):
- Add `SandboxRuntimeService` interface with Daytona implementation.
- Maintain `work_item_sandbox_bindings` table:
  - `work_item_id`, `sandbox_id`, `state`, `snapshot_id`, `last_synced_at`, `last_manifest_hash`
- Add sync workers:
  - `hydrateSandbox(workItemID)`
  - `flushSandboxChanges(workItemID)`
  - `archiveIdleSandboxes()`

Frontend (React):
- Show runtime state badge per thread/work item (cold/starting/warm/stopped/archived/error).
- Expose "Resume environment" and "Archive now" actions in work-item detail.
- Stream logs/status via backend WS/SSE relay (not direct Daytona API from browser).

### Why not DB-backed FUSE first?

Direct virtual FS (FUSE/WebDAV bridge) increases complexity and fragility for agent tooling. Start with fast rsync/materialize + incremental sync-back. Add advanced live mounts only if needed.

## 4) Cost model and rough economics

### Daytona published pricing signals

From Daytona pricing/limits docs:
- Pay-as-you-go compute
- vCPU: `$0.00001400/s`
- Memory: `$0.00000450/GiB/s`
- Storage: `$0.00000003/GiB/s` (after 5GB free)
- $200 free compute credit
- Tiers gate quota and networking behavior

Default sandbox footprint in docs is 1 vCPU / 1 GiB / 3 GiB disk.

Approx default running cost:
- `0.000014 + 0.0000045 + (3 * 0.00000003) = 0.00001859/s`
- ~`$0.0669/hour` (~`$48/month` if 24/7 continuously running)

This is the key product decision:
- One always-on sandbox per work item can become expensive quickly.
- Auto-stop + archive + short-lived task sandboxes drastically lower costs.

### Practical unit economics guidance

For writing workflows (burst usage), model cost around:
- Active edit/agent minutes per day
- Number of concurrently active agent tasks (not total stored work items)
- Snapshot restore frequency
- Storage persistence policy

## 5) Alternatives comparison for Meridian use case

## Summary table

| Option | Isolation model | Strengths | Weaknesses | Fit for Meridian |
|---|---|---|---|---|
| Daytona | Container namespace isolation (plus Sysbox-referenced infra), managed sandbox platform | Rich SDK/API, snapshots, toolbox ops, webhooks, built for agent runtimes | Less hard isolation than microVM offerings, pricing/limits tier complexity | Good managed default if you need full shell/tool parity soon |
| E2B | Firecracker microVM-based sandboxes | Strong isolation, agent-focused SDK, templates/snapshots | Concurrency/plan limits and session windows by tier; another external control plane | Strong candidate where stronger isolation is required |
| Fly Machines | Firecracker microVM infra primitives | Powerful, flexible, global infra, strong isolation | You build more control-plane logic yourself | Good if Meridian wants infra ownership and custom orchestration |
| Modal Sandboxes | Secure container sandboxes, high-scale serverless platform | Very strong scale/ops posture, broad compute options, rich ecosystem | More general compute platform than writing-specific runtime; pricing can drift with misuse | Good for high-scale or GPU-adjacent futures, heavier than needed for v1 writing |
| Firecracker (self-managed) | Hardware-virtualized microVMs | Strong isolation + startup guarantees | High ops burden (scheduler, images, networking, lifecycle, observability) | Usually too much for current Meridian stage |
| nsjail (self-hosted) | Linux namespaces/seccomp/cgroups process jail | Lightweight, cheap, flexible | Not VM boundary, higher security risk for hostile code, ops burden | Good for trusted internal workloads; risky for multi-tenant untrusted execution |

## Notes on each alternative

E2B:
- Purpose-built agent sandboxes.
- Pricing docs show base + usage model, concurrency and session limits by plan.
- Supports snapshots and lifecycle controls.

Fly Machines:
- Firecracker-based and billed per second in started state.
- Also charges for stopped rootfs usage.
- Great primitive layer; more DIY for full agent runtime experience.

Modal:
- Sandbox product includes network controls and high concurrency claims.
- Published pricing is per-second CPU/memory (plus GPU).
- Strong for large-scale dynamic compute; may be broader than needed for text-heavy flows.

Firecracker directly:
- Excellent underlying primitive with explicit startup/overhead specs.
- You must build the whole platform around it.

nsjail:
- Lightweight Linux process isolation (namespaces/cgroups/seccomp).
- Useful but not a hardware-virtualization boundary.

## 6) How other AI platforms appear to handle sandboxed execution

Based on public docs/blogs:

- Cursor:
  - Background Agents run in remote isolated Ubuntu-based machines with package install + internet access.
  - Secrets are encrypted at rest and injected into background agent environments.

- Replit:
  - Replit has historically described each Repl running in its own container.
  - Agent/checkpoint features snapshot app/workspace state.

- Bolt (StackBlitz):
  - Runs using WebContainers (WASM-based browser runtime), with compute in-browser rather than a traditional cloud VM per task.
  - Strong UX and instant startup for web stacks, but browser-memory/resource limits can surface.

- Lovable:
  - Docs emphasize autonomous agent execution, verification tooling, and separate Test/Live cloud environments.
  - Engineering blog describes isolated Node.js containers orchestrated in clusters for app copies.

- Windsurf:
  - Public docs emphasize IDE-integrated workflow, remote indexing, and enterprise remote-dev/proxy support.
  - Less explicit public detail on a dedicated per-task remote sandbox model akin to Cursor background agents.

## 7) Integration complexity for Go backend + React frontend

Estimated complexity (Daytona path): **medium**.

Main workstreams:
- Backend runtime abstraction + Daytona adapter
- Sandbox lifecycle state machine
- File hydration/sync service with conflict handling
- Auth/key management + scoped secrets
- Frontend status/controls and resilience UX

Likely incremental rollout:
1. Phase 1: Manual "Start sandbox for work item" + one-shot hydrate/flush.
2. Phase 2: Auto-stop/archive, snapshots, and resumable sessions.
3. Phase 3: Background sync, better merge/conflict UX, policy controls.

## 8) Cold starts: what to expect

Daytona marketing claims millisecond spin-up; architecture and snapshots support quick starts, but real latency depends on:
- Whether snapshot/image is already warm on runner
- Region proximity
- Hydration payload size (your document tree materialization)
- First-run dependency installs

For Meridian, user-perceived start time should be budgeted as:
- Runtime boot (often fast) + document hydration (dominant for large work items)

Practical target:
- Keep "first actionable shell" under ~2-5s for common work items via snapshots + incremental hydration.

## 9) Security considerations and guarantees

Daytona security-relevant controls from docs:
- Org-scoped multi-tenancy and role/assignment model
- API key scopes
- Audit logs and webhook events
- Sandbox network controls (`networkAllowList`, `networkBlockAll`), tier-based egress restrictions
- Namespace-level sandbox isolation with per-sandbox resources

Important caveat:
- Namespace/container isolation is not equivalent to hardware microVM isolation. If hostile, arbitrary code from untrusted tenants is core, assess whether you need Firecracker-class boundaries.

Recommended baseline controls for Meridian regardless of provider:
- Per-work-item short-lived credentials
- Default deny egress + narrow allowlists
- Immutable audit trail for tool actions
- Strict secrets scoping (never global workspace secrets in every sandbox)
- Hard CPU/memory/time limits + kill switches

## 10) Is this overkill for a writing platform?

Short answer: **can be overkill if applied as always-on per-work-item sandboxes**.

For mostly text-document workflows, a lighter architecture (DB-native operations + selected tool workers) is often enough.

What sandboxes unlock meaningfully:
- Real bash/tooling parity for advanced agents
- Deterministic reproducible environments per task
- Safer execution boundary for code/tools that should not run in app backend directly
- Future extensibility (import pipelines, lint/transforms, browser automation, external CLI integrations)

Balanced recommendation for Meridian v1:
- Do not default to persistent sandbox per work item.
- Use **ephemeral or resumable sandboxes for high-complexity tasks only**.
- Gate usage via policy (task type, user tier, cost guardrails).
- Measure adoption and success before expanding footprint.

## Suggested decision

If you need production-ready full-tool agents in the near term, choose Daytona for fastest integration and ship with conservative lifecycle/cost controls.

If your primary near-term agent tasks remain document editing and planning, postpone universal sandboxing and add sandbox runtime only to specific workflows that clearly benefit.

## Sources

Daytona:
- https://www.daytona.io/docs/
- https://www.daytona.io/docs/en/architecture/
- https://www.daytona.io/docs/en/sandboxes/
- https://www.daytona.io/docs/en/snapshots/
- https://www.daytona.io/docs/tools/api/
- https://www.daytona.io/docs/en/limits/
- https://www.daytona.io/docs/en/network-limits/
- https://www.daytona.io/docs/en/webhooks/
- https://www.daytona.io/docs/configuration/
- https://www.daytona.io/docs/en/audit-logs/
- https://www.daytona.io/pricing
- https://www.daytona.io/changelog/architecture-docs-org-timeouts

E2B:
- https://e2b.dev/docs
- https://e2b.dev/docs/sandbox
- https://e2b.dev/docs/sandbox/snapshots
- https://e2b.dev/docs/template/how-it-works
- https://e2b.dev/docs/billing
- https://e2b.dev/pricing

Fly:
- https://fly.io/docs/reference/architecture/
- https://fly.io/docs/about/billing/
- https://fly.io/docs/about/pricing/
- https://fly.io/blog/fly-machines/

Modal:
- https://modal.com/docs/guide/sandboxes
- https://modal.com/docs/guide/sandbox-networking
- https://modal.com/docs/guide/sandbox-files
- https://modal.com/docs/guide/security
- https://frontend.modal.com/docs/guide/cold-start
- https://modal.com/pricing

Firecracker:
- https://github.com/firecracker-microvm/firecracker
- https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md

nsjail:
- https://github.com/google/nsjail

Platform usage references:
- Cursor Background Agents: https://docs.cursor.com/en/background-agents
- Replit Agent docs: https://docs.replit.com/replitai/agent
- Replit container architecture note: https://blog.replit.com/ssh
- StackBlitz/Bolt + WebContainers: https://stackblitz.com/ and https://support.bolt.new/faqs/troubleshooting/webcontainer
- Lovable modes/environments: https://docs.lovable.dev/features/modes and https://docs.lovable.dev/features/environments
- Lovable container orchestration note: https://lovable.dev/pt-br/blog/engineering/visual-edits
- Windsurf docs (remote indexing/remote setup context): https://docs.windsurf.com/context-awareness/remote-indexing and https://docs.windsurf.com/pt-BR/troubleshooting/plugins-enterprise/jetbrains-proxy
