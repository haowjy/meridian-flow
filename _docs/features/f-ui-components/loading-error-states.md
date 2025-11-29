---
stack: frontend
status: complete
feature: "Loading and Error States"
---

# Loading and Error States

**Skeletons, spinners, and error boundaries.**

## Status: ✅ Complete

---

## Loading States

**Skeleton Loaders**: Documents, editor, chat
**Spinner Overlays**: Chat loading, streaming
**Button Disabled States**: During operations

---

## Error Boundaries

**Pattern**: React Error Boundaries catch component errors

**Features**: ErrorPanel with retry button, logging

**Note**: Vite handles errors differently than Next.js - error boundaries are implemented at component level rather than via framework-specific files

---

## Toast Notifications

**Sonner**: Error toasts, save status, streaming warnings

**File**: `frontend/src/shared/components/ui/sonner.tsx`

---

## Related

- See [custom-components.md](custom-components.md) for ErrorPanel
