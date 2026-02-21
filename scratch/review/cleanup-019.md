# Cleanup 019

- Category: Architecture (SRP)
- File: `frontend/src/core/stores/useTreeStore.ts:1`
- Issue: File is 1142 lines (>500 rule) and mixes multiple responsibilities (tree loading/cache policy, optimistic CRUD, offline queue orchestration, hydration-from-tool-view, and multi-select UI state).
- Why this is a problem: High coupling and large blast radius make regressions likely and reviews difficult; violates repository SRP guidance.
- Suggested fix:
1. Split into focused modules: load/cache actions, optimistic mutation helpers, hydration adapter, selection store/actions.
2. Keep the Zustand store thin by importing pure helper functions/services.
3. Add targeted tests per extracted module.
