---
stack: frontend
status: complete
feature: "User Settings - Profile UI"
---

# Profile UI

**User avatar, profile menu, and settings page.**

## Status: ✅ Complete

---

## Features

### Avatar Display
- Google profile image with initials fallback
- Deterministic colors from email hash (HSL)
- 4 sizes: xs (20px), sm (24px), md (32px), lg (48px)

### User Menu
- Bottom-left of workspace sidebar (compact design)
- Top-right of project selection page
- Actions: Settings, Sign out
- Menu builder pattern (extensible)

### Settings Page (`/settings`)
- Account info display (avatar, name, email)
- Sign out button
- Respects navigation history (`router.back()`)

---

## Architecture

SOLID principles applied:

```
hooks/
├── useSupabaseSession.ts   # Layer 1: Observe auth state
├── useUserProfile.ts       # Layer 2: Transform to UserProfile
└── useAuthActions.ts       # Layer 3: Actions (signOut)

components/
├── UserAvatar.tsx          # Pure presentational
├── UserMenu.tsx            # Menu renderer (Open/Closed)
└── UserMenuButton.tsx      # Composition component

utils/
└── menuBuilders.tsx        # Factory for menu items
```

**Key patterns:**
- **Layered hooks**: Each hook has single responsibility
- **Props-based components**: No hooks in presentational components (testable)
- **Menu builder factory**: `createUserMenuItems()` for extensibility

---

## Implementation Files

- `frontend/src/features/auth/` - All hooks, components, types
- `frontend/src/routes/_authenticated/settings.tsx` - Settings page
