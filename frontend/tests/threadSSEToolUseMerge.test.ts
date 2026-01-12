import { describe, it, expect } from 'vitest'
import { buildToolUseContentFromJSONDelta } from '@/features/threads/hooks/useThreadSSE'

describe('buildToolUseContentFromJSONDelta', () => {
  it('merges input JSON into existing tool_use content', () => {
    const existing = { tool_name: 'doc_edit', tool_use_id: 'toolu_123', input: {} }
    const parsed = { path: '/ch01.md', command: 'append' }

    expect(buildToolUseContentFromJSONDelta(existing, parsed)).toEqual({
      tool_name: 'doc_edit',
      tool_use_id: 'toolu_123',
      input: { path: '/ch01.md', command: 'append' },
    })
  })

  it('returns parsed content unchanged when it already looks like full tool content', () => {
    const existing = { tool_name: 'doc_edit', tool_use_id: 'toolu_123', input: {} }
    const parsed = { tool_name: 'doc_edit', tool_use_id: 'toolu_456', input: { path: '/x.md' } }

    expect(buildToolUseContentFromJSONDelta(existing, parsed)).toEqual(parsed)
  })

  it('handles non-object existing content', () => {
    expect(buildToolUseContentFromJSONDelta(null, { path: '/x.md' })).toEqual({
      input: { path: '/x.md' },
    })
  })

  it('handles non-object parsed content by preserving existing tool metadata', () => {
    const existing = { tool_name: 'doc_view', tool_use_id: 'toolu_999' }
    const parsed = 'not-json-object'

    expect(buildToolUseContentFromJSONDelta(existing, parsed)).toEqual({
      tool_name: 'doc_view',
      tool_use_id: 'toolu_999',
      input: 'not-json-object',
    })
  })
})

