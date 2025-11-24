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

**Files**:
- `frontend/src/app/error.tsx` - Page-level errors
- `frontend/src/app/global-error.tsx` - App-level errors

**Features**: ErrorPanel with retry button, logging

---

## Toast Notifications

**Sonner**: Error toasts, save status, streaming warnings

**File**: `frontend/src/shared/components/ui/sonner.tsx`

---

## Related

- See [custom-components.md](custom-components.md) for ErrorPanel
