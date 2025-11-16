# Multi-Provider Support

**Current**: Single provider per message

**Future**: Switch providers mid-conversation

## Features

- Provider selector in UI
- Different providers for different tasks
- Cost tracking per provider
- Provider-specific features (e.g., Claude's artifacts)

## Example

```
User message → Claude Opus (quality)
Quick question → GPT-4o-mini (speed/cost)
Code generation → Claude Sonnet (balance)
```

## Benefits

- Optimize cost vs quality
- Leverage provider strengths
- User flexibility

## Implementation

### Provider Selector UI

```tsx
<MessageInput>
  <ProviderSelector
    value={selectedProvider}
    onChange={setSelectedProvider}
  >
    <option value="claude-opus">Claude Opus ($$$)</option>
    <option value="claude-sonnet">Claude Sonnet ($$)</option>
    <option value="gpt-4o">GPT-4o ($$)</option>
    <option value="gpt-4o-mini">GPT-4o-mini ($)</option>
  </ProviderSelector>

  <Textarea />
  <Button>Send</Button>
</MessageInput>
```

### Cost Tracking

```typescript
interface ProviderUsage {
  providerId: string;
  messagesCount: number;
  tokensUsed: number;
  estimatedCost: number;
}

const trackUsage = async (turnId: string, provider: string) => {
  const turn = await getTurn(turnId);

  await db.providerUsage.add({
    providerId: provider,
    messagesCount: 1,
    tokensUsed: turn.inputTokens + turn.outputTokens,
    estimatedCost: calculateCost(provider, turn.inputTokens, turn.outputTokens),
  });
};
```

### Provider Display

```tsx
<AssistantMessage>
  <MessageHeader>
    <Avatar provider={message.provider} />
    <ProviderBadge>{message.provider}</ProviderBadge>
  </MessageHeader>
  <MessageContent>{message.content}</MessageContent>
</AssistantMessage>
```

## Priority

**Medium** - High value, relatively simple UI change
