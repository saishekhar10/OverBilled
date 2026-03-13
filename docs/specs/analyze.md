# Spec: POST /api/analyze

## Overview
Authenticated API route that accepts a medical bill or denial letter upload,
runs it through the Claude extraction pipeline, and persists the results to
Supabase. This is the core data pipeline of OverBilled.

---

## File Location
`src/app/api/analyze/route.ts`

---

## Authentication
- Use the server-side Supabase client from `src/lib/supabase/server.ts`
- Call `supabase.auth.getUser()` at the start of the handler
- If no valid session, return `401 Unauthorized` immediately
- All Supabase writes must use the authenticated client so RLS policies apply

---

## Request Format
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body field: `file` — the uploaded document

---

## Validation
Reject with `400 Bad Request` if:
- No file is present in the request
- MIME type is not one of: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`
- File size exceeds 10MB (10 * 1024 * 1024 bytes)

---

## Step-by-Step Logic

### 1. Upload file to Supabase Storage
- Bucket: `uploads`
- Path: `{user_id}/uploads/{timestamp}-{original_filename}`
- Use `supabase.storage.from('uploads').upload(path, buffer)`
- On upload error, return `500` with message

### 2. Create document row
Insert into `documents` table:
```
user_id     = authenticated user's ID
type        = null (unknown until analysis completes — Claude will determine)
file_path   = storage path from step 1
file_name   = original filename from the upload
status      = 'processing'
```
Hold the returned `document.id` for subsequent steps.

### 3. Call Claude extraction
- Import `analyzeDocument` from `src/lib/analyze.ts`
- Pass the file buffer and MIME type
- If Claude call throws, catch the error, update `documents.status` to `'error'`, return `500`

### 4. Write analysis to database
Insert into `analyses` table:
```
document_id    = document.id from step 2
extracted_data = full result minus issues, summary, total_recoverable
issues         = result.issues array
summary        = result.summary string
```
Hold the returned `analysis.id`.

### 5. Update document status and type
Update the `documents` row:
```
type      = result.document_type  (now known from Claude)
status    = 'analyzed'
```

### 6. Return success response
```json
{
  "success": true,
  "document_id": "uuid",
  "analysis_id": "uuid",
  "analysis": { ...full Claude result... }
}
```

---

## Error Handling
Every step that can fail must:
1. Catch the error and log it with `console.error`
2. If a document row was already created, update its status to `'error'`
3. Return `500` with a generic error message — never expose raw error details to the client

---

## Response Shape (success)
```typescript
{
  success: boolean
  document_id: string
  analysis_id: string
  analysis: AnalysisResult  // imported type from src/lib/analyze.ts
}
```

---

## Dependencies
- `src/lib/supabase/server.ts` — server Supabase client
- `src/lib/analyze.ts` — analyzeDocument() function + AnalysisResult type
- Next.js built-in `Request` — for reading multipart form data

---

## Notes
- Do not use any external file upload libraries — use Next.js native `request.formData()`
- The `type` column on documents is intentionally left null on insert and updated
  after Claude determines the document type. Do not try to infer type from filename.
- Bucket name is `uploads` — not `documents`
- Storage path must include `{user_id}` as the first segment for RLS to work correctly