# Cleanup 022

- Category: Project conventions / Dead code & Complexity
- File: multiple (frontend logging outside thread/SSE)
- Issue: Excessive `debug`/`info` logging in high-frequency frontend stores/services/helpers creates console noise and production log churn (default prod level is `info`). Some logs also expose verbose request payload context in dev (`updateProject` updates).
- Why this is a problem: Reduces signal-to-noise for real failures, increases overhead during normal flows, and violates writer-first focus by over-instrumenting routine state transitions.
- Suggested minimal actionable logging set:
1. Keep `warn`/`error` for unexpected failures, protocol parse errors, and permanent mutation failures.
2. Keep `info` only for rare lifecycle boundaries if operationally necessary (ideally none in hot paths).
3. Remove `debug` in steady-state paths outside thread/SSE.

- Remove/demote logs at these locations:
1. `frontend/src/core/stores/useEditorStore.ts:56`
2. `frontend/src/core/stores/useEditorStore.ts:107`
3. `frontend/src/core/stores/useEditorStore.ts:139`
4. `frontend/src/core/stores/useEditorStore.ts:164`
5. `frontend/src/core/stores/useEditorStore.ts:197`
6. `frontend/src/core/stores/useEditorStore.ts:218`
7. `frontend/src/core/stores/useProjectStore.ts:178`
8. `frontend/src/core/stores/useProjectStore.ts:182`
9. `frontend/src/core/lib/panelHelpers.ts:67`
10. `frontend/src/core/lib/panelHelpers.ts:97`
11. `frontend/src/core/lib/panelHelpers.ts:130`
12. `frontend/src/core/lib/sync.ts:63`
13. `frontend/src/core/lib/sync.ts:74`
14. `frontend/src/core/lib/sync.ts:90`
15. `frontend/src/core/lib/sync.ts:107`
16. `frontend/src/core/lib/sync.ts:116`
17. `frontend/src/core/services/treeSyncService.ts:49`
18. `frontend/src/core/services/treeSyncService.ts:94`
19. `frontend/src/core/lib/persistentSaveDrain.ts:59`
20. `frontend/src/core/lib/persistentSaveDrain.ts:66`
21. `frontend/src/core/lib/persistentSaveDrain.ts:93`
22. `frontend/src/core/lib/persistentSaveDrain.ts:104`
23. `frontend/src/core/lib/persistentSaveDrain.ts:124`
24. `frontend/src/core/lib/treeQueueDrain.ts:113`
25. `frontend/src/core/lib/treeQueueDrain.ts:127`
26. `frontend/src/core/lib/treeQueueDrain.ts:145`
27. `frontend/src/core/lib/treeQueueDrain.ts:196`
28. `frontend/src/core/lib/treeQueueDrain.ts:207`
29. `frontend/src/core/lib/treeQueueDrain.ts:227`
30. `frontend/src/core/stores/useTreeStore.ts:441`
31. `frontend/src/core/stores/useTreeStore.ts:675`
32. `frontend/src/core/stores/useTreeStore.ts:727`
33. `frontend/src/core/stores/useTreeStore.ts:781`
34. `frontend/src/core/stores/useTreeStore.ts:837`
35. `frontend/src/core/stores/useTreeStore.ts:897`
36. `frontend/src/core/stores/useTreeStore.ts:959`
37. `frontend/src/features/documents/hooks/useInlineReview.ts:165`
38. `frontend/src/features/documents/hooks/useInlineReview.ts:198`
39. `frontend/src/features/documents/hooks/useInlineReview.ts:385`
40. `frontend/src/features/documents/hooks/useInlineReview.ts:391`
41. `frontend/src/features/documents/hooks/useInlineReview.ts:407`
42. `frontend/src/features/documents/hooks/useInlineReview.ts:415`
43. `frontend/src/features/documents/hooks/useInlineReview.ts:430`
44. `frontend/src/features/documents/hooks/useInlineReview.ts:446`
45. `frontend/src/features/documents/hooks/useInlineReview.ts:448`
46. `frontend/src/features/documents/hooks/useInlineReview.ts:467`
47. `frontend/src/features/documents/hooks/useInlineReview.ts:508`
48. `frontend/src/features/documents/hooks/useDocumentCollab.ts:218`
49. `frontend/src/features/documents/hooks/useDocumentCollab.ts:237`

- Additional convention fix:
1. Replace direct `console.error` with namespaced logger in `frontend/src/features/documents/hooks/useDocumentSync.ts:112`.
