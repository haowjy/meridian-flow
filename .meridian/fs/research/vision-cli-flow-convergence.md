# Vision: CLI ↔ Flow Convergence

The meridian CLI and meridian-flow (the web app) are two interfaces to the same system. The file-based orchestration workflow in the CLI (work items, spawns, design docs, reviews, phase plans) becomes a feature of the product.

## The Bridge

The "local bridge" connects filesystem-based agent coordination to the web-based Flow UI. Same data model, two access patterns:

| CLI (filesystem) | Flow (web app) |
|-------------------|----------------|
| `.meridian/work/` directories | Work items in the UI |
| `meridian spawn` | Agent threads |
| Design docs, phase plans | Artifacts attached to work items |
| Fan-out reviewers | "Get feedback on my chapter" from multiple agents |
| Orchestrator decomposition | Agent planning mode |
| `meridian work` dashboard | Project dashboard |

## For Writers

What the dev-orchestrator does for code, the writer-orchestrator does for stories:

- "Revision pass on Arc 3" as a tracked work item with phases
- Fan out agents for continuity, pacing, voice consistency — in parallel
- Story bibles, character sheets, plot outlines as living artifacts
- Phase-based execution: outline → draft → review → revise

## Why This Works

- Same skill/agent package format works in both CLI and Flow (marketplace unification)
- Git is already the shared substrate — CLI writes files, Flow syncs them
- The orchestration patterns are domain-agnostic — they work for code and for fiction
- Dogfooding: building Meridian with the same workflow that Meridian offers to writers
