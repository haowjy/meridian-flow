---
stack: both
status: partial
feature: "User Settings"
---

# User Settings

**User profile display and preferences configuration.**

## Status

| Component | Backend | Frontend |
|-----------|---------|----------|
| Profile UI | N/A | ✅ Complete |
| Preferences API | ✅ Complete | ❌ Missing |

---

## Features

- **Profile UI**: Avatar, user menu, settings page - [profile-ui.md](profile-ui.md)
- **Preferences API**: JSONB storage, 5 categories - [preferences-api.md](preferences-api.md)

---

## Future Enhancements

### Project-Specific Settings
- Route: `/projects/[id]/settings`
- Per-project configuration (model defaults, system instructions)

### User Preferences UI
- Connect to existing backend API
- Categories: models, ui, editor, system_instructions, notifications

---

## Related Documentation

- **Authentication**: See [fb-authentication/](../fb-authentication/) for security (JWT, protected routes)
