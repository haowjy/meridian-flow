---
title: API Testing - Comprehensive Guide
description: Complete manual testing guide for all Meridian backend API endpoints
created_at: 2025-10-31
updated_at: 2025-10-31
author: Jimmy Yao
category: technical
tracked: true
---

# Testing Guide

Complete guide to testing the Meridian backend manually before building the frontend.

## Prerequisites

- Backend server running (`go run ./cmd/server/main.go`)
- `curl` or [HTTPie](https://httpie.io/) installed
- Or use a tool like [Postman](https://www.postman.com/) or [Insomnia](https://insomnia.rest/)

## Test Sequence

Follow this sequence to test all functionality:

### 1. Health Check ✅

```bash
curl http://localhost:8080/health
```

**Expected response:**
```json
{
  "status": "ok",
  "time": "2025-10-31T12:34:56Z"
}
```

### 2. Create First Document ✅

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Chapter 1",
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": {"level": 1},
          "content": [{"type": "text", "text": "The Beginning"}]
        },
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "Once upon a time, there was a "},
            {"type": "text", "marks": [{"type": "bold"}], "text": "brave knight"},
            {"type": "text", "text": " who set out on an "},
            {"type": "text", "marks": [{"type": "italic"}], "text": "epic journey"},
            {"type": "text", "text": "."}
          ]
        }
      ]
    }
  }'
```

**Expected:**
- Status: `201 Created`
- Returns the created document with:
  - Generated UUID `id`
  - `content_markdown` (auto-generated)
  - `word_count` (calculated automatically)
  - Timestamps

**Save the returned `id` for next tests!**

### 3. Create More Documents ✅

Create a document in a folder:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Characters/Elara",
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": {"level": 2},
          "content": [{"type": "text", "text": "Elara the Mage"}]
        },
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "A powerful sorceress with silver hair."}
          ]
        },
        {
          "type": "bulletList",
          "content": [
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [{"type": "text", "text": "Age: 127"}]
                }
              ]
            },
            {
              "type": "listItem",
              "content": [
                {
                  "type": "paragraph",
                  "content": [{"type": "text", "text": "Element: Lightning"}]
                }
              ]
            }
          ]
        }
      ]
    }
  }'
```

Another character:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Characters/Theron",
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": {"level": 2},
          "content": [{"type": "text", "text": "Theron the Warrior"}]
        },
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "A seasoned fighter with a mysterious past."}
          ]
        }
      ]
    }
  }'
```

### 4. List All Documents ✅

```bash
curl http://localhost:8080/api/documents
```

**Expected:**
```json
{
  "documents": [
    {
      "id": "...",
      "path": "Chapter 1",
      "word_count": 15,
      ...
    },
    {
      "id": "...",
      "path": "Characters/Elara",
      ...
    },
    {
      "id": "...",
      "path": "Characters/Theron",
      ...
    }
  ],
  "total": 3
}
```

### 5. Get Single Document ✅

Replace `{id}` with an actual document ID from step 2:

```bash
curl http://localhost:8080/api/documents/{id}
```

**Expected:**
- Full document with all fields
- TipTap JSON content
- Generated Markdown
- Word count

### 6. Update Document (Content) ✅

Update the content of a document:

```bash
curl -X PUT http://localhost:8080/api/documents/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": {"level": 1},
          "content": [{"type": "text", "text": "The Beginning - Revised"}]
        },
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "Updated content with more details."}
          ]
        }
      ]
    }
  }'
```

**Expected:**
- Status: `200 OK`
- Updated `content_markdown`
- New `word_count`
- Updated `updated_at` timestamp

### 7. Rename Document (Path) ✅

Rename a document by updating its path:

```bash
curl -X PUT http://localhost:8080/api/documents/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Chapter 1 - The Journey Begins"
  }'
```

**Expected:**
- Status: `200 OK`
- Document with new path
- Content unchanged

### 8. Move Document to Folder ✅

Move a document into a folder structure:

```bash
curl -X PUT http://localhost:8080/api/documents/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Chapters/Chapter 1"
  }'
```

### 9. Test Duplicate Path (Should Fail) ❌

Try to create a document with an existing path:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Chapter 1",
    "content_tiptap": {
      "type": "doc",
      "content": []
    }
  }'
```

**Expected:**
- Status: `409 Conflict`
- Error message about duplicate path

### 10. Test Invalid Path (Should Fail) ❌

Try to create a document with invalid characters:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Invalid/Path/With/Special@#$Characters",
    "content_tiptap": {
      "type": "doc",
      "content": []
    }
  }'
```

**Expected:**
- Status: `400 Bad Request`
- Error message about invalid characters

### 11. Delete Document ✅

Delete one of your test documents:

```bash
curl -X DELETE http://localhost:8080/api/documents/{id}
```

**Expected:**
- Status: `204 No Content`
- Empty response body

### 12. Verify Deletion ✅

Try to get the deleted document:

```bash
curl http://localhost:8080/api/documents/{id}
```

**Expected:**
- Status: `404 Not Found`

### 13. List Documents Again ✅

Verify the document was removed:

```bash
curl http://localhost:8080/api/documents
```

**Expected:**
- Total count decreased by 1
- Deleted document not in list

## Test with Complex TipTap Content

Test the TipTap to Markdown converter with various formatting:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Test Formatting",
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": {"level": 1},
          "content": [{"type": "text", "text": "Test All Formatting"}]
        },
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "This has "},
            {"type": "text", "marks": [{"type": "bold"}], "text": "bold"},
            {"type": "text", "text": ", "},
            {"type": "text", "marks": [{"type": "italic"}], "text": "italic"},
            {"type": "text", "text": ", and "},
            {"type": "text", "marks": [{"type": "code"}], "text": "inline code"},
            {"type": "text", "text": "."}
          ]
        },
        {
          "type": "heading",
          "attrs": {"level": 2},
          "content": [{"type": "text", "text": "Lists"}]
        },
        {
          "type": "bulletList",
          "content": [
            {
              "type": "listItem",
              "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "First item"}]}
              ]
            },
            {
              "type": "listItem",
              "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Second item"}]}
              ]
            }
          ]
        },
        {
          "type": "orderedList",
          "content": [
            {
              "type": "listItem",
              "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Numbered one"}]}
              ]
            },
            {
              "type": "listItem",
              "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Numbered two"}]}
              ]
            }
          ]
        },
        {
          "type": "codeBlock",
          "attrs": {"language": "javascript"},
          "content": [
            {"type": "text", "text": "const hello = \"world\";"}
          ]
        },
        {
          "type": "blockquote",
          "content": [
            {
              "type": "paragraph",
              "content": [{"type": "text", "text": "A wise quote"}]
            }
          ]
        }
      ]
    }
  }'
```

**Check the response** - the `content_markdown` field should contain clean, readable Markdown with all formatting preserved.

## Word Count Test

Create a document with known word count:

```bash
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Word Count Test",
    "content_tiptap": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {"type": "text", "text": "One two three four five six seven eight nine ten"}
          ]
        }
      ]
    }
  }'
```

**Expected:**
- `word_count` should be `10`

## Success Criteria

If all these tests pass, your backend is working perfectly:

- ✅ Create documents with TipTap JSON
- ✅ List all documents
- ✅ Get individual documents
- ✅ Update document content
- ✅ Rename documents (update path)
- ✅ Delete documents
- ✅ Prevent duplicate paths
- ✅ Validate paths
- ✅ Convert TipTap to Markdown
- ✅ Count words accurately
- ✅ Handle complex formatting

## Using HTTPie (Alternative)

If you prefer HTTPie over curl:

```bash
# Create document
http POST localhost:8080/api/documents \
  path="Chapter 1" \
  content_tiptap:='{"type":"doc","content":[]}'

# List documents
http GET localhost:8080/api/documents

# Update document
http PUT localhost:8080/api/documents/{id} \
  path="New Name"

# Delete document
http DELETE localhost:8080/api/documents/{id}
```

## Next Steps

Once all tests pass:

1. ✅ Backend is fully functional
2. 📝 Move to frontend development
3. 🔗 Connect frontend to these API endpoints
4. 🎉 Build the editor interface

## Troubleshooting

### Connection refused
- Make sure the server is running
- Check if port 8080 is correct (matches your `.env`)

### 500 Internal Server Error
- Check server logs in the terminal
- Verify database connection
- Make sure migrations were run

### Document not created
- Check request JSON is valid
- Verify `content_tiptap` has correct structure
- Look at server logs for specific error

---

**Happy Testing!** 🚀

