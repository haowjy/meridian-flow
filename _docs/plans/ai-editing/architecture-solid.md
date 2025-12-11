# SOLID Architecture Patterns

This document summarizes the SOLID principles applied to the AI editing feature.

---

## Overview

| Principle | Where Applied | Benefit |
|-----------|---------------|---------|
| **S**ingle Responsibility | Split services, hooks, components | Each component does one thing well |
| **O**pen/Closed | Command registries | Add new commands without modifying existing code |
| **L**iskov Substitution | N/A | No inheritance hierarchy in this feature |
| **I**nterface Segregation | Split repository & hook interfaces | Components depend only on what they need |
| **D**ependency Inversion | API abstractions | Easy to test, swap implementations |

---

## S - Single Responsibility

### Backend: Split Service Components

```
Before: AISessionService.AddEdit() does everything
After:
   AIVersionUpdater      → applies edits to ai_version string
   AISessionService      → orchestrates, delegates to repository
```

**Files**: `phase-1-version-db.md` (service interface)

### Frontend: Split Components

```
Before: EditorPanel handles everything
After:
   useAIDiff hook        → computes diff(USER_EDITS, ai_version)
   AIToolbar component   → Accept All / Reject All buttons
   DiffHunk component    → inline diff display per hunk
```

**Files**: `phase-4-live-diff.md`, `phase-5-accept-ui.md`

---

## O - Open/Closed

### Backend: Edit Command Registry

Add new edit commands (e.g., `delete`, `move`) without modifying existing code:

```go
type EditCommand interface {
    Name() string
    Validate(input map[string]interface{}) error
    Execute(ctx, tool, input) (*EditResult, error)
    ApplyToVersion(current string, input) (string, error)
}

// To add new command: implement interface, register
registry.Register(&DeleteCommand{})
```

**Files**: `phase-2-suggest-tool.md` (command registry)

### Frontend: Simplified by Live Diff

With the live diff approach, frontend doesn't need an applier registry. The frontend:
1. Fetches `ai_version` from session
2. Computes `diff(USER_EDITS, ai_version)`
3. Renders diff hunks

No per-command appliers needed - all edits are handled uniformly by the diff algorithm.

**Files**: `phase-4-live-diff.md`

---

## I - Interface Segregation

### Backend: Split Repository Interface

Components depend only on what they need:

```go
// Read-only components use this
type AISessionReader interface {
    GetSession(ctx, id) (*AISession, error)
    GetActiveSession(ctx, docID) (*AISession, error)
    // ...
}

// Write-only components use this
type AISessionWriter interface {
    CreateSession(ctx, session) error
    UpdateSessionStatus(ctx, id, status) error
    // ...
}

// Full access when needed
type AISessionRepository interface {
    AISessionReader
    AISessionWriter
    AIEditRepository
}
```

**Files**: `phase-1-version-db.md` (repository interfaces)

### Frontend: Split Hooks

Components get only the API they need:

```typescript
// Display-only components
function useAISessionQuery(documentId) { ... }

// Action components
function useAISessionMutations() { ... }

// Full access when needed
function useAISession(documentId) {
    return { ...useAISessionQuery(documentId), ...useAISessionMutations() }
}
```

**Files**: `phase-5-accept-ui.md` (split hooks)

---

## D - Dependency Inversion

### Frontend: API Abstraction

Hooks depend on abstract interface, not HTTP implementation:

```typescript
// Abstract interface
interface AISessionAPI {
    getActiveSession(documentId): Promise<AISession | null>
    resolveSession(sessionId, status): Promise<void>
}

// Concrete implementation
class HttpAISessionAPI implements AISessionAPI { ... }

// Mock for testing
class MockAISessionAPI implements AISessionAPI { ... }

// Usage - can inject any implementation
function useAISession(documentId: string, api: AISessionAPI) { ... }
```

**Files**: `phase-5-accept-ui.md` (API abstraction)

---

## Adding New Features

### Adding a New Edit Command (e.g., `delete`)

1. **Backend**: Implement `EditCommand` interface
   ```go
   type DeleteCommand struct{}
   func (c *DeleteCommand) Name() string { return "delete" }
   func (c *DeleteCommand) Execute(...) { ... }
   func (c *DeleteCommand) ApplyToVersion(...) { ... }
   ```

2. **Backend**: Register in `NewEditCommandRegistry()`
   ```go
   r.Register(&DeleteCommand{})
   ```

3. **Update tool definition** in `tool_definition.go` to include new command in enum

No frontend changes needed - live diff handles all edit types uniformly!

---

## Testing Benefits

| Component | How to Test |
|-----------|-------------|
| `StrReplaceCommand` | Unit test with mock session |
| `AISessionService` | Inject mock repository |
| `useAIDiff` | Unit test with sample strings |
| `useAISession` | Inject mock API |

Each component can be tested in isolation.

---

## File References

| Phase | SOLID Patterns |
|-------|----------------|
| `phase-1-version-db.md` | Interface Segregation (repository) |
| `phase-2-suggest-tool.md` | Open/Closed (command registry) |
| `phase-4-live-diff.md` | Single Responsibility (hooks, components) |
| `phase-5-accept-ui.md` | All patterns (hooks, API abstraction) |
