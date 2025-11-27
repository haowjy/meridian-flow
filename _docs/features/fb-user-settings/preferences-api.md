---
stack: backend
status: complete
feature: "User Settings - Preferences API"
---

# Preferences API

**User-specific settings stored as JSONB.**

## Backend: ✅ Complete

---

## API

- `GET /api/users/me/preferences`
- `PATCH /api/users/me/preferences`

**Storage**: JSONB field with 5 categories

---

## Preference Categories

| Category | Settings |
|----------|----------|
| **models** | favorites, default model |
| **ui** | theme, font size, compact mode, word count display |
| **editor** | auto-save, word wrap, spellcheck |
| **system_instructions** | Custom LLM instructions |
| **notifications** | email updates, in-app alerts |

---

## Implementation Files

- `backend/internal/handler/*preferences*`
- `backend/internal/service/user_preferences_service.go`
- `backend/internal/repository/*preferences*`

---

## Frontend: ❌ Missing

No settings UI to edit preferences yet. See [profile-ui.md](profile-ui.md) for current settings page (read-only account info).
