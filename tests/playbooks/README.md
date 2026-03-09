# Playbooks

Structured markdown instructions for LLM-driven exploratory testing.

An agent reads a playbook, executes the probes using shell/curl/WS tools,
and reports pass/fail with evidence.

## Playbook Format

```markdown
# Goal
What this playbook validates.

# Prerequisites
- Running dev server at $BASE_URL
- Valid ACCESS_TOKEN in .env

# Setup
Steps to seed test data (create project, document, etc.)

# Probes
Numbered steps with expected outcomes:
1. Do X -> expect Y
2. Do Z -> expect W

# Invariants
Things that must ALWAYS be true (no console errors, no data loss, etc.)

# Teardown
Cleanup steps.

# Report Format
Pass/fail per probe, evidence (response bodies, screenshots, etc.)
```

## Why Playbooks

- Smoke tests catch known bugs. Playbooks catch unknown bugs.
- An LLM can vary timing, ordering, and input in ways static tests don't.
- Playbooks are cheap to write and don't need compilation.
- Stable probes graduate into real Go/Playwright tests over time.
