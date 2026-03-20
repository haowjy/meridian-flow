# Notifications

Toast notifications and error surfacing for optimistic updates.

## Scope

- Toast system (success, error, warning, info)
- Auto-dismiss with configurable duration
- Optimistic update failure surfacing ("Save failed — retrying..." → "Saved" or "Failed, click to retry")
- Credit-related alerts (low balance, credits exhausted)
- Agent status notifications (thread completed, agent error)
- Stack/queue behavior for multiple simultaneous toasts

## Carry Forward

- Existing toast patterns in the frontend (if any)
- Existing error handling patterns in stores

## Design Notes

- Toasts should not interrupt writing flow — position bottom-right or bottom-center
- Errors that require action (retry, navigate) get persistent toasts with action buttons
- Informational toasts auto-dismiss after 3-5 seconds

## Dependencies

- Design system (toast component)
