# Gemini Provider Implementation Notes

## Thinking Block Signature Handling

### Critical Pattern (Applied in Anthropic)

**Signature is provider-specific metadata, NOT semantic content:**

```go
// Correct pattern (used in Anthropic adapter)
case "thinking":
    thinking := content.Thinking
    signature := content.Signature

    // No signature = unverifiable, convert to text
    if signature == "" {
        return &llmprovider.Block{
            BlockType:   llmprovider.BlockTypeText,
            Sequence:    sequence,
            TextContent: &thinking,
            Provider:    &provider,
        }, nil
    }

    // Store signature in ProviderData (metadata)
    providerDataMap := map[string]interface{}{
        "signature": signature,
    }
    providerData, _ := json.Marshal(providerDataMap)

    return &llmprovider.Block{
        BlockType:    llmprovider.BlockTypeThinking,
        Sequence:     sequence,
        TextContent:  &thinking,
        Content:      nil,            // No semantic content
        Provider:     &provider,
        ProviderData: providerData,   // Signature here
    }, nil
```

### Why This Matters

1. **Signature is cryptographic verification** - Not part of the conversation content
2. **Provider-specific** - Anthropic and Gemini may use different signature schemes
3. **Non-portable** - Other providers cannot verify another provider's signatures
4. **Storage location** - `provider_data` JSONB column, NOT `content` column

### Gemini-Specific Considerations

**Known from user:**
- Gemini supports `thought_signature` (extended thinking feature)
- Signature format may differ from Anthropic's implementation

**When implementing Gemini adapter:**

1. **Check Gemini SDK for signature field name:**
   - Might be `thought_signature` instead of `signature`
   - Check response structure in Gemini API docs

2. **Apply same pattern:**
   - Unsigned thinking � convert to `text` block
   - Signed thinking � store signature in `ProviderData`
   - Keep `Content` nil for thinking blocks

3. **Handle provider-specific fields:**
   ```go
   // Example for Gemini (adjust based on actual SDK)
   case "thinking":
       thinking := content.ThinkingText
       signature := content.ThoughtSignature  // May be different field name

       if signature == "" {
           return &llmprovider.Block{
               BlockType:   llmprovider.BlockTypeText,
               TextContent: &thinking,
               Provider:    &provider,
           }, nil
       }

       providerDataMap := map[string]interface{}{
           "thought_signature": signature,  // Use Gemini's field name
       }
       // ... rest same as Anthropic
   ```

4. **Signature verification:**
   - Only Gemini can verify Gemini signatures
   - Only Anthropic can verify Anthropic signatures
   - Frontend should display signature presence, but not attempt verification

### Database Schema

```sql
-- Thinking blocks store signature in provider_data
SELECT
    block_type,
    text_content,      -- The thinking text
    content,           -- NULL for thinking blocks
    provider,          -- "gemini" or "anthropic"
    provider_data      -- {"signature": "..."} or {"thought_signature": "..."}
FROM turn_blocks
WHERE block_type = 'thinking';
```

### Testing Checklist

When implementing Gemini:

- [ ] Test thinking with signature � stored in `provider_data`
- [ ] Test thinking without signature � converted to `text` block
- [ ] Verify `content` column is NULL for thinking blocks
- [ ] Test signature deltas during streaming (separate `signature_delta` events)
- [ ] Verify provider field set to `"gemini"`
- [ ] Test multi-provider conversation (Anthropic thinking + Gemini thinking)
- [ ] Ensure signatures don't cross-verify (each provider verifies its own only)

### References

- Anthropic implementation: `meridian-llm-go/providers/anthropic/adapter.go:140-172`
- Backend schema: `backend/internal/domain/models/llm/turn_block.go:26`
- Migration: `backend/migrations/00002_add_provider_data.sql`
- Streaming architecture: `_docs/technical/llm/streaming/README.md`

### Related Issues

- Signature in `content` vs `provider_data` - Resolved 2025-11-15
- Unsigned thinking blocks should become text - Implemented 2025-11-15
- ExecutionSide field for tools - Implemented 2025-11-15

---

## Google Grounding Metadata Handling

### New Architecture (Updated 2025-11-16)

**Server-side search results are now converted to tool_result blocks with normalized format:**

```go
// Current pattern (Anthropic adapter)
case "web_search_tool_result":
    contentMap := make(map[string]interface{})
    contentMap["tool_use_id"] = content.ToolUseID
    contentMap["tool_name"] = "web_search"

    // Check for error vs success
    if content.Content.Type == "web_search_tool_result_error" {
        contentMap["is_error"] = true
        contentMap["error_code"] = string(content.Content.ErrorCode)
    } else {
        // Normalize search results to portable format
        sources := content.Content.OfWebSearchResultBlockArray
        results := make([]map[string]interface{}, 0, len(sources))

        for _, source := range sources {
            result := map[string]interface{}{
                "title":     source.Title,
                "url":       source.URL,
                "page_age":  source.PageAge,
                // snippet omitted (EncryptedContent cannot be decrypted)
            }
            results = append(results, result)
        }
        contentMap["results"] = results
    }

    return &llmprovider.Block{
        BlockType:    llmprovider.BlockTypeToolResult,
        Content:      contentMap,
        Provider:     &provider,
        ProviderData: rawData,  // Full raw block preserved for replay
    }, nil
```

**Text blocks now support citations:**
```go
case "text":
    text := content.Text

    // Convert Anthropic citations to library format
    var citations []llmprovider.Citation
    for _, cite := range content.Citations {
        if cite.Type == "web_search_result_location" {
            citation := llmprovider.Citation{
                Type:        "web_search_result",
                URL:         cite.URL,
                Title:       cite.Title,
                CitedText:   &cite.CitedText,
                ProviderData: // encrypted_index stored here
            }
            citations = append(citations, citation)
        }
    }

    return &llmprovider.Block{
        BlockType:   llmprovider.BlockTypeText,
        TextContent: &text,
        Citations:   citations,  // NEW: Citations array
        Provider:    &provider,
    }, nil
```

### Why This Matters

1. **Same-provider replay works perfectly** - ProviderData allows exact block replay (Anthropic SDK accepts server_tool_use and web_search_tool_result in requests)
2. **Cross-provider splitting** - Server tools from different providers are split into synthetic conversation turns
3. **Normalized results format** - Consistent `{title, url, page_age}` structure across providers
4. **Citations link text to sources** - Text blocks can reference search results via citations

### Google's Grounding Metadata Structure

**Example response:**

```json
{
  "groundingMetadata": {
    "searchEntryPoint": {
      "renderedContent": "<style>...</style><div class='container'>
        <svg class='logo'>...</svg>
        <a class='chip' href='https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ...'>
          short poem
        </a>
      </div>"
    },
    "webSearchQueries": ["short poem"]
  }
}
```

**Key differences from Anthropic:**
- ❌ No direct source URLs/titles (unlike Anthropic's extractable sources)
- ✅ Has `webSearchQueries` (search terms used)
- ✅ Has `renderedContent` (HTML widget with search link)
- ❌ Search link is JavaScript-gated (not directly accessible)

### Gemini-Specific Considerations

**When implementing Google/Gemini adapter:**

1. **Grounding metadata is at response level** (not block level):
   - Located in `GenerateResponse.GroundingMetadata`
   - NOT part of content blocks like Anthropic
   - Includes `groundingChunks` (sources) and `groundingSupports` (citations)

2. **Convert to SYNTHETIC tool_result block:**
   ```go
   // Example for Google adapter
   func convertGroundingToToolResult(metadata *GroundingMetadata, sequence int) *llmprovider.Block {
       if len(metadata.GroundingChunks) == 0 {
           return nil
       }

       // Create synthetic tool_result with normalized results
       contentMap := map[string]interface{}{
           "tool_use_id": "google_grounding_" + generateID(),  // Synthetic ID
           "tool_name":   "web_search",
       }

       results := make([]map[string]interface{}, 0, len(metadata.GroundingChunks))
       for _, chunk := range metadata.GroundingChunks {
           if chunk.Web != nil {
               result := map[string]interface{}{
                   "title": chunk.Web.Title,
                   "url":   chunk.Web.URI,
               }
               results = append(results, result)
           }
       }
       contentMap["results"] = results

       provider := "google"
       return &llmprovider.Block{
           BlockType: llmprovider.BlockTypeToolResult,
           Sequence:  sequence,
           Content:   contentMap,
           Provider:  &provider,
       }
   }
   ```

3. **Convert groundingSupports to Citations:**
   ```go
   // Map groundingSupports to text block citations
   func convertGroundingSupports(supports []GroundingSupport, chunks []GroundingChunk) []llmprovider.Citation {
       citations := make([]llmprovider.Citation, 0)

       for _, support := range supports {
           citation := llmprovider.Citation{
               Type:       "grounding_support",
               CitedText:  &support.Segment.Text,
               StartIndex: &support.Segment.StartIndex,
               EndIndex:   &support.Segment.EndIndex,
           }

           // Link to source chunks
           if len(support.GroundingChunkIndices) > 0 {
               // Use first chunk index for now
               idx := support.GroundingChunkIndices[0]
               citation.ResultIndex = &idx

               // Get URL/title from chunk
               if idx < len(chunks) && chunks[idx].Web != nil {
                   citation.URL = chunks[idx].Web.URI
                   citation.Title = chunks[idx].Web.Title
               }
           }

           citations = append(citations, citation)
       }
       return citations
   }
   ```

4. **Preserve full grounding metadata in ProviderData:**
   ```go
   // Store complete grounding metadata in text block's ProviderData
   providerData, _ := json.Marshal(metadata.GroundingMetadata)

   return &llmprovider.Block{
       BlockType:    llmprovider.BlockTypeText,
       TextContent:  &text,
       Citations:    convertGroundingSupports(supports, chunks),
       Provider:     &provider,
       ProviderData: providerData,  // Full grounding metadata
   }
   ```

5. **Block sequence for Google responses:**
   ```
   1. [Optional] Synthetic tool_result (groundingChunks → results)
   2. Text block (model response with Citations from groundingSupports)
   ```

6. **Frontend rendering:**
   - Display tool_result as "Search Results" with links
   - Show text with inline citations (linked to result indices)
   - Optionally extract `renderedContent` HTML widget from ProviderData

### Comparison: Anthropic vs Google

**Anthropic:**
```
I searched the web and found these sources:

1. [Public Domain Poetry - Main Index](https://www.public-domain-poetry.com/)
2. [Poems for Your Poetry Project](https://poets.org/anthology/poems-your-poetry-project-public-domain)
   (Published: April 20, 2017)
```

**Google:**
```
I searched Google for information.
```

**Why the difference:**
- Anthropic provides extractable sources (title, URL, page_age)
- Google provides search queries + HTML widget (sources not directly exposed)
- Both approaches create portable text blocks

### Storage Strategy

**Block-level (portable, replayable):**
```sql
INSERT INTO turn_blocks (block_type, text_content, provider)
VALUES ('text', 'I searched Google for information.', 'google');
```

**Response-level (ephemeral, for debugging/UI):**
```sql
UPDATE turns SET response_metadata = '{
  "grounding_metadata": {
    "searchEntryPoint": { "renderedContent": "..." },
    "webSearchQueries": ["short poem"]
  }
}'
```

### Testing Checklist

When implementing Google/Gemini:

- [ ] Test grounding metadata → converted to text block
- [ ] Verify `renderedContent` HTML preserved in `response_metadata`
- [ ] Test conversation replay (text block should be sent, metadata skipped)
- [ ] Verify provider field set to `"google"`
- [ ] Test multi-provider conversation (Anthropic sources + Google search)
- [ ] Frontend can extract and render HTML widget (optional)
- [ ] Verify search link works in browser (may require JavaScript)

### References

- Anthropic implementation: `meridian-llm-go/providers/anthropic/adapter.go:226-238`
- Google grounding docs: https://ai.google.dev/gemini-api/docs/grounding
- Response metadata handling: `internal/domain/services/llm/types.go`

### Related Issues

- Server-side tool results in assistant messages - Resolved 2025-11-15
- web_search_tool_result conversion to text - In Progress 2025-11-15
- Grounding metadata storage strategy - Designed 2025-11-15
