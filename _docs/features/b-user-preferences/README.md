---
stack: backend
status: complete
feature: "User Preferences"
---

# User Preferences

**User-specific settings stored as JSONB.**

## Backend: ✅ Complete

**Storage**: JSONB field, 5 categories (models, ui, editor, system_instructions, notifications)

**API**:
- `GET /api/users/me/preferences`
- `PATCH /api/users/me/preferences`

**Files**: `backend/internal/{handler,service,repository}/*preferences*`

---

## Frontend: ❌ Missing

No settings UI (no settings page or dialog)

---

## Preference Categories

- **models**: favorites, default model
- **ui**: theme, font size, compact mode, word count display
- **editor**: auto-save, word wrap, spellcheck
- **system_instructions**: Custom LLM instructions
- **notifications**: email updates, in-app alerts

---

## Related

- See `backend/internal/service/user_preferences_service.go` for implementation
