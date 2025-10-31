# Meridian Documentation Structure

```
_docs/
├── README.md                  # This file
├── hidden/                    # Work-in-progress, not for general audience
│   ├── brainstorming/        # Exploration, multiple options, tagged with <EXPLORING>, <DECIDED>, <DEFERRED>
│   ├── status/               # Milestones, completion markers (tracked: false)
│   └── tasks/                # Sprint planning, task breakdowns (tracked: false)
├── high-level/               # Product vision, strategy (tracked: true)
└── technical/                # Architecture, APIs, finalized specs (tracked: true)
```

## Directory Guide

| Directory | Purpose | Tracked | Tone |
|-----------|---------|---------|------|
| `high-level/` | Product vision, strategy, what we're building | `true` | Polished, decided |
| `technical/` | Architecture, APIs, implementation specs | `true` | Polished, decided |
| `hidden/brainstorming/` | Exploration, options, questions | `false` | Skeletal, uncertain OK |
| `hidden/status/` | Milestone markers, progress updates | `false` | Informational |
| `hidden/tasks/` | Sprint planning, task tracking | `false` | Working notes |

## Core Principles

### 1. Brainstorming vs Official Documentation

| Brainstorming (`hidden/`) | Official (`high-level/`, `technical/`) |
|---------------------------|---------------------------------------|
| Multiple options coexist | Single decided version |
| Uncertainty preserved | Only finalized info |
| Skeletal capture | Polished and complete |

**Brainstorming tags:**
- `<EXPLORING>` - Options being considered
- `<DECIDED>` - Decision made, ready to promote to official docs
- `<DEFERRED>` - Explicitly postponed

### 2. Source Tagging in Brainstorming

**Default (no tag)** = User stated it

**Use `<AI>` tag** for AI suggestions/possibilities:
```markdown
## Authentication
- JWT tokens (duration TBD)
- Email/password login

## Open questions:
- Token expiration? <AI>1hr with refresh? 24hr without?</AI>
- Storage? <AI>Redis for sessions vs stateless JWT?</AI>

<DECIDED>Short-lived (1hr) + refresh tokens</DECIDED>
```

Brainstorming is collaborative - AI can suggest, just mark it clearly.

### 3. Flexible Structure

No rigid templates. Simple docs stay simple. Complex topics get detail when needed. Structure fits content.

## Frontmatter (Required)

```yaml
---
title: Document Title
description: One-line summary
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
author: Author Name
category: [high-level|technical|brainstorming|status|tasks]
tracked: [true|false]
---
```

**Category:** Must match directory name.

**Tracked:**
- `true` for official docs (`high-level/`, `technical/`)
- `false` for work-in-progress (`hidden/*`)

**Example:**
```yaml
---
title: API Specification
description: REST API endpoints and request/response formats
created_at: 2025-10-30
updated_at: 2025-10-30
author: Jimmy Yao
category: technical
tracked: true
---
```

---

## Quick Reference

**File naming:** `kebab-case.md`, numbered for ordered docs (`1-overview.md`)

**Update `updated_at`** when: Adding sections, changing decisions, fixing significant errors

**Don't update `updated_at`** when: Typos, minor formatting

---

**Last Updated:** 2025-10-31
