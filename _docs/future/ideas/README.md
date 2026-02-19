# Future Ideas & Enhancements

Features and improvements to consider post-MVP.

## Categories

### Search
- [Vector Search](./search/vector-search.md) - Semantic search using pgvector embeddings
- [Hybrid Search](./search/hybrid-search.md) - FTS + vector search with RRF

### AI Behaviors
- [Proactive Assistance](./ai-behaviors/proactive-assistance.md) - AI detects issues and suggests improvements
- [Consistency Checking](./ai-behaviors/consistency-checking.md) - Detect contradictions across documents
- [AI Suggestions (3-Way Merge)](./ai-behaviors/ai-suggestions.md) - Collaborative editing with conflict resolution
- [Line-Oriented Edit Commands](./ai-behaviors/line-oriented-edit-commands.md) - Add internal `delete_lines`/`replace_lines` for robust multiline edits

### Infrastructure
- [Redis-Based Streaming](./infrastructure/redis-streaming.md) - Distributed SSE streaming for horizontal scaling
- [Retry Strategies](./infrastructure/retry-strategies.md) - Intelligent LLM API retry logic

### Performance & Optimization
- [Frontend Optimization](./performance/frontend-optimization.md) - Lazy loading, caching, prefetch strategies
- [Virtual Scrolling](./performance/virtual-scrolling.md) - Handle large document trees
- [Incremental Loading](./performance/incremental-loading.md) - Progressive data loading
- [Offline Support](./performance/offline-support.md) - Offline-first capabilities

### Thread UI
- [AI Auto-Titling](./thread-ui/ai-auto-titling.md)
- [Copy-Paste Detection & Custom Blocks](./thread-ui/copy-paste-detection.md)
- [Auto-Collapse Large Messages](./thread-ui/auto-collapse.md)
- [Message Search](./thread-ui/message-search.md)
- [Keyboard Shortcuts](./thread-ui/keyboard-shortcuts.md)
- [Export Conversation](./thread-ui/export-conversation.md)
- [Message Threads & Branching](./thread-ui/message-threads.md)

### Document Integration
- [Document Reference Blocks](./document-integration/reference-blocks.md)
- [Automatic Context Detection](./document-integration/auto-context.md)

### Collaborative Features
- [Multi-User Threads](./collaborative/multi-user-threads.md)
- [Shared Context](./collaborative/shared-context.md)

### AI Provider Features
- [Multi-Provider Support](./ai-providers/multi-provider-support.md)
- [Advanced Provider Features](./ai-providers/advanced-features.md)

### Performance & Scale
- [Virtual Scrolling](./performance/virtual-scrolling.md)
- [Incremental Loading](./performance/incremental-loading.md)
- [Offline Support](./performance/offline-support.md)

### Voice & Multimodal
- [Voice Input](./multimodal/voice-input.md)
- [Voice Output](./multimodal/voice-output.md)
- [Image Support](./multimodal/image-support.md)

### Organization & Management
- [Thread Folders](./organization/thread-folders.md)
- [Thread Tags](./organization/thread-tags.md)
- [Thread Templates](./organization/thread-templates.md)

### Analytics & Insights
- [Usage Statistics](./analytics/usage-statistics.md)
- [Conversation Insights](./analytics/conversation-insights.md)

### Mobile
- [Native Mobile Apps](./mobile/native-apps.md)

### Integration & API
- [Third-Party Integrations](./integrations/third-party.md)
- [Public API](./integrations/public-api.md)

### Monetization
- [Premium Thread Features](./monetization/premium-features.md)

### Accessibility
- [Screen Reader Optimization](./accessibility/screen-reader.md)
- [Dyslexia-Friendly Mode](./accessibility/dyslexia-mode.md)

## Implementation Priority

| Feature | Priority | Complexity | Impact | Featureset |
|---------|----------|------------|--------|-----------|
| Vector Search | High | Medium | High | Search |
| Consistency Checking | High | High | High | AI Behaviors |
| AI Auto-Titling | High | Low | High | Thread UI |
| Proactive Assistance | Medium | High | High | AI Behaviors |
| Message Search | High | Medium | High | Thread UI |
| Document References | High | Medium | High | Document Integration |
| Hybrid Search | Medium | Medium | Medium | Search |
| Retry Strategies | Medium | Low | Medium | Infrastructure |
| AI Suggestions (3-Way Merge) | Medium | High | High | AI Behaviors |
| Keyboard Shortcuts | Medium | Low | Medium | Thread UI |
| Redis Streaming | Low | Medium | Low | Infrastructure |
| Copy-Paste Detection | Medium | Medium | Medium | Thread UI |
| Export Conversation | Medium | Low | Medium | Thread UI |
| Frontend Optimization | Medium | Medium | Medium | Performance |
| Multi-Provider UI | Medium | Low | High | AI Providers |
| Message Threads | Low | High | Medium | Thread UI |
| Multi-User Threads | Low | High | High | Collaborative |
| Virtual Scrolling | Low | Medium | Low | Performance |
| Voice Input | Low | Medium | Medium | Multimodal |
| Thread Folders | Medium | Low | Medium | Organization |
| Analytics | Low | Medium | Low | Analytics |
| Mobile App | Low | High | High | Mobile |

**Next to implement after MVP** (by priority):
1. **Vector Search** - Enables semantic document search and consistency checking
2. **AI Auto-Titling** - Low complexity, high impact (use cheap provider)
3. **Message Search** - Essential for navigating conversations
4. **Document References** - Core to writing workflow
5. **Consistency Checking** - High-value AI behavior (requires vector search)
