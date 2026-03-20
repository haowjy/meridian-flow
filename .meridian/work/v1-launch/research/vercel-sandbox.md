# Vercel Sandbox/Bash Research (as of 2026-03-19)

## Executive summary
- Vercel's actual remote execution product is **Vercel Sandbox** (`@vercel/sandbox`, plus `sandbox` CLI).
- There is **no official `@vercel/bash` package** on npm. The phrase "bash by Vercel" most likely refers to **Vercel Labs `just-bash`** and `bash-tool` (open-source, in-process virtual bash), not the hosted Sandbox product.
- For a writing platform that mainly needs file read/write/search and only occasional shell, **Daytona or E2B are usually a better fit than Vercel Sandbox when your control plane is Go**, because they expose clearer non-TS integration paths (Daytona includes a Go SDK).
- If the workload is mostly text transformations and search (not untrusted arbitrary binaries), the simplest/cheapest option is often **no remote VM at all**: use `just-bash` or native tooling inside your app workers.

## 1. What Vercel offers for sandboxed execution

### Product
- **Vercel Sandbox**: isolated compute environments for AI workflows.
- Core capabilities documented across SDK/docs/landing page:
  - Create/start/stop sandboxes.
  - Run commands (`runCommand`) and interactive terminal sessions (`createTTY`).
  - File ops (`writeFiles`, `readFile`, upload/download/copy).
  - Snapshots (checkpoint environment and clone from snapshot).
  - Network policy controls (`allow-all`, `deny-all`, `user-defined`) and request header transformations for egress secrets.

### Runtime/environment notes (official docs/changelog)
- CLI announcement states Node and Python sandbox workloads.
- SDK docs include creation options for `node24`, `python3.13`, and `snapshot` sources.
- Limits/pricing page documents plan-level limits: concurrency, max runtime, creation/storage/transfer quotas.

## 2. SDK/API: creating/running/managing sandboxes

### Vercel
- Main SDK: `@vercel/sandbox` (TypeScript).
- Typical flow:
  1. `Sandbox.create(...)`
  2. `sandbox.runCommand(...)` / `sandbox.createTTY(...)`
  3. file operations and optional `sandbox.snapshot()`
  4. `sandbox.stop()`
- CLI exists for operational workflows (`npx sandbox ...`).
- Auth docs mention **Sandbox access tokens** and OIDC-based flows.

### Daytona
- TypeScript SDK and **Go SDK** docs are first-class.
- `Daytona.create(...)` supports resource/lifecycle parameters (`autoStopInterval`, `autoArchiveInterval`, `autoDeleteInterval`), volumes, network options.
- Rich typed interfaces for process, PTY, filesystem, snapshots, volumes.

### E2B
- JS/TS + Python SDKs plus API reference.
- Core model: `Sandbox.create()`, `sandbox.commands.run(...)`, filesystem APIs, connect/list/pause/kill/timeout.
- Extensive docs around persistence, snapshots, autoresume, interactive terminal, and secure access.

## 3. Pricing/cost model

## Vercel Sandbox (official pricing doc)
- Hobby included monthly quota:
  - Active CPU: **5 hours/month**
  - Provisioned memory: **420 GB-hours/month**
  - Creations: **5,000/month**
  - Data transfer: **20 GB/month**
  - Storage: **15 GB lifetime**
- Pro/Enterprise usage rates shown:
  - Active CPU: **$0.128/hour**
  - Provisioned memory: **$0.0212/GB-hour**
  - Creations: **$0.60 / 1M**
  - Data transfer: **$0.15/GB**
  - Storage: **$0.08/GB-month**

## Daytona (pricing page)
- Pay-as-you-go, per-second pricing listed:
  - vCPU: **$0.00001400/s**
  - Memory: **$0.00000450/GiB/s**
  - Storage: **$0.00000003/GiB/s**
- Marketing text indicates **$200 free compute** and startup credits programs.

## E2B (pricing page)
- Usage billed per running second.
- Example listed CPU rates (Hobby/Pro):
  - 1 vCPU: **$0.000014/s**
  - 2 vCPU (default): **$0.000028/s**
  - 4 vCPU: **$0.000056/s**
- Memory: **$0.0000045/GiB/s**
- Storage shown as included quotas on plan page (e.g., 10 GiB hobby, 20 GiB pro).

### Pricing interpretation for your use case
- For long-lived remote sandboxes doing mostly text work, memory + idle/lifecycle behavior can dominate cost.
- Vercel adds explicit creation + transfer + storage billing dimensions; Daytona/E2B pricing is easier to model from resource-seconds.
- For document-heavy workloads without heavy code execution, all three can be overkill versus in-process tools.

## 4. Cold starts

### Documented claims
- **Vercel Sandbox**: marketing copy says launch sandboxes in milliseconds; snapshot clone path is positioned as near-instant.
- **Daytona**: pricing/marketing copy says milliseconds, including "Sub 90ms sandbox creation" claim in page metadata.
- **E2B**: template docs discuss snapshots loading in around **~80ms**.

### Practical note
- None of these claims are equivalent to a hard P95 SLA across regions/template sizes. For architecture decisions, benchmark your own template + command mix.

## 5. Real-world issues/patterns (what tends to go wrong)

### Vercel Sandbox
- Public repo is relatively young; open items include missing lower-level process features (e.g., writing to stdin of running process) and file permission ergonomics.
- Signal: feature surface is evolving quickly.

### E2B
- Recent issues include command streaming hangs when connectivity degrades, reconnect edge cases, pause/kill behavior mismatches, and template-create failures.
- Signal: mature feature set, but distributed lifecycle edge cases still appear under stress.

### Daytona
- Recent issues include proxy/status-code translation confusion, preview URL behavior after idle transitions, and error detail propagation gaps.
- Signal: powerful platform, but lifecycle/proxy ergonomics can create operator friction.

## 6. Integration complexity for Go backend + React frontend

### Vercel Sandbox
- Strongest path is TS/Node integration (`@vercel/sandbox`) or CLI-driven operations.
- For a Go-centric backend, common pattern is a small Node sidecar/service owning sandbox orchestration.
- If you already run heavily on Vercel and Node tooling, this can still be straightforward.

### Daytona
- Best native fit for Go backend because official docs include Go SDK alongside TS/Python/Ruby.
- Fewer cross-language bridge layers if orchestration should remain in Go.

### E2B
- Strong JS/Python ergonomics plus API reference; Go integration generally means using HTTP API wrappers.
- Good option if your agent control plane is already JS/TS.

## 7. Is Vercel Sandbox simpler/cheaper than Daytona for this writing-focused use case?

Short answer: **not clearly**.

- **Simpler**:
  - If your stack is TS/Node + Vercel-native operations, Vercel Sandbox can feel simpler.
  - If your orchestration backend is Go, Daytona is often simpler because of the Go SDK and direct lifecycle primitives.

- **Cheaper**:
  - No obvious universal win for Vercel from published rates.
  - For text-centric workloads, the cheapest path is often to avoid cloud VM sandboxes for most turns.

### Recommended approach
1. Default to **in-process/local tool execution** for document read/write/search (or Vercel Labs `just-bash` if you specifically want a safe bash-like environment).
2. Escalate to cloud sandbox only for tasks that truly require isolated Linux process execution.
3. If you keep orchestration in Go, prefer **Daytona** first, then evaluate E2B.
4. Consider Vercel Sandbox if you want tighter Vercel ecosystem alignment and are comfortable running sandbox control in TS/Node.

## "Bash by Vercel" clarification
- `npm view @vercel/bash` returns 404 (no such package).
- There is a Vercel Labs project:
  - `just-bash` (TypeScript in-memory bash interpreter)
  - `bash-tool` (AI SDK tool wrapper)
- So "bash by Vercel" likely means **Vercel Labs `just-bash`/`bash-tool`**, not the hosted Vercel Sandbox runtime.

## Sources
- Vercel Sandbox overview: https://vercel.com/sandbox
- Vercel Sandbox SDK reference: https://vercel.com/docs/vercel-sandbox/sdk-reference
- Vercel run commands docs: https://vercel.com/docs/vercel-sandbox/run-commands
- Vercel auth docs: https://vercel.com/docs/vercel-sandbox/authentication
- Vercel CLI reference: https://vercel.com/docs/vercel-sandbox/cli-reference
- Vercel pricing/limits: https://vercel.com/docs/vercel-sandbox/pricing
- Vercel system specs: https://vercel.com/docs/vercel-sandbox/system-specifications
- Vercel changelog (CLI): https://vercel.com/changelog/vercel-sandbox-cli-is-now-available
- just-bash: https://justbash.dev/
- just-bash repo: https://github.com/vercel-labs/just-bash
- bash-tool repo: https://github.com/vercel-labs/bash-tool
- Daytona pricing: https://www.daytona.io/pricing
- Daytona docs (sandboxes lifecycle): https://www.daytona.io/docs/en/sandboxes/lifecycle/
- Daytona TS SDK `Daytona` class: https://www.daytona.io/docs/en/typescript-sdk/daytona/
- Daytona TS SDK `Sandbox`: https://www.daytona.io/docs/en/typescript-sdk/sandbox/
- E2B pricing: https://e2b.dev/pricing
- E2B docs home: https://e2b.dev/docs
- E2B JS SDK sandbox reference: https://e2b.dev/docs/sdk-reference/js-sdk/v1.4.0/sandbox
- E2B docs sandbox section: https://e2b.dev/docs/sandbox

### Issue evidence (real-world failure patterns)
- Vercel sandbox issue: https://github.com/vercel/sandbox/issues/51
- E2B issues: https://github.com/e2b-dev/E2B/issues/1128, https://github.com/e2b-dev/E2B/issues/1130, https://github.com/e2b-dev/E2B/issues/1215, https://github.com/e2b-dev/E2B/issues/1074, https://github.com/e2b-dev/E2B/issues/1031, https://github.com/e2b-dev/E2B/issues/1154
- Daytona issues: https://github.com/daytonaio/daytona/issues/4142, https://github.com/daytonaio/daytona/issues/4048, https://github.com/daytonaio/daytona/issues/3899, https://github.com/daytonaio/daytona/issues/3846, https://github.com/daytonaio/daytona/issues/3854, https://github.com/daytonaio/daytona/issues/3960
