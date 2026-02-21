# Cleanup 021

- Category: Architecture (SRP)
- File: `frontend/src/features/documents/hooks/useInlineReview.ts:1`
- Issue: File is 534 lines (>500 rule) and mixes CM6 extension wiring, proposal/chunk business rules, toolbar state derivation, navigation behavior, and sync effects.
- Why this is a problem: Multiple responsibilities in one hook make correctness bugs (accept/reject/finalize races) harder to isolate and test.
- Suggested fix:
1. Extract pure review-domain actions (accept/reject/finalize logic) into a service module.
2. Keep hook focused on wiring refs/effects to CM6 and UI callbacks.
3. Add unit tests for extracted business logic (auto-finalize and accept-all failure paths).
