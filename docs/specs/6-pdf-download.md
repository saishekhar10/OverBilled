# Spec 6: PDF Download

## Overview
Wires up the `DownloadPdfButton` component (currently a "coming soon" stub) to
generate and download a properly formatted PDF of the dispute letter. The PDF
should look like a real typed document — letterhead area, date, addressed to the
correct recipient, body text with correct line breaks, and a signature block.

This spec covers:
1. Installing a PDF generation library (`pdfkit`)
2. A new API route: `GET /api/letter/[id]/pdf`
3. A `DownloadPdfButton` client component wired to that route
4. The PDF document layout

---

## Library Choice

Use **`pdfkit`** (Node.js). It works cleanly in Next.js App Router Route
Handlers, requires no bundler plugins, and outputs a readable single-file PDF
without React dependencies.

Install:
```bash
npm install pdfkit
npm install --save-dev @types/pdfkit
```

`pdfkit` streams output. In a Next.js Route Handler, collect the stream into a
`Buffer` using a helper, then return it as a `Response` with the correct headers.

---

## Files to Create
- `src/app/api/letter/[id]/pdf/route.ts`

## Files to Update
- `src/components/DownloadPdfButton.tsx` — replace "coming soon" stub

---

## 1. PDF Generation Route

### File: `src/app/api/letter/[id]/pdf/route.ts`

### Method
`GET`

### Auth
Same pattern as all other routes — check `Authorization` header first,
fall back to cookie session. Return 401 if no valid session.

### Step-by-step logic

**Step 1 — Extract ID from params**
```typescript
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // ...
}
```

**Step 2 — Auth check**
```typescript
// Try Authorization header first
const authHeader = request.headers.get('Authorization')
let supabase: SupabaseClient
let userId: string

if (authHeader?.startsWith('Bearer ')) {
  const token = authHeader.slice(7)
  supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return new Response('Unauthorized', { status: 401 })
  userId = user.id
} else {
  const cookieStore = await cookies()
  supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cs) { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) }
      }
    }
  )
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return new Response('Unauthorized', { status: 401 })
  userId = user.id
}
```

**Step 3 — Fetch letter from database**
```typescript
const { data: letter, error: letterError } = await supabase
  .from('letters')
  .select('*, documents(*)')
  .eq('id', id)
  .single()

if (letterError || !letter) {
  return new Response('Letter not found', { status: 404 })
}
```
RLS ensures the user can only access their own letters.

**Step 4 — Generate PDF**
Call the `buildLetterPdf(letter)` helper (defined in the same file or in
`src/lib/pdf-builder.ts`). This returns a `Buffer`.

**Step 5 — Return PDF response**
```typescript
return new Response(pdfBuffer, {
  status: 200,
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="dispute-letter-${id.slice(0, 8)}.pdf"`,
    'Content-Length': pdfBuffer.length.toString(),
  }
})
```

---

## 2. PDF Layout — `buildLetterPdf(letter)`

Define `buildLetterPdf` as an async function in the same route file or in
`src/lib/pdf-builder.ts`. It accepts the letter row (with `documents` joined)
and returns a `Promise<Buffer>`.

### Stream-to-buffer helper
```typescript
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}
```

### PDFKit setup
```typescript
import PDFDocument from 'pdfkit'

async function buildLetterPdf(letter: LetterWithDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 72, right: 72 }  // 1 inch margins
  })

  // Collect output
  const bufferPromise = streamToBuffer(doc)

  // --- Build document content ---
  buildContent(doc, letter)

  doc.end()
  return bufferPromise
}
```

### Document structure

Build `buildContent(doc, letter)` to produce the following layout:

```
[Date: right-aligned, e.g. "March 13, 2026"]

[Blank line]

[Recipient block — left-aligned]
Billing Department                    (for hospital letters)
  OR
Appeals Department                    (for insurer letters)
[Provider name from documents.* or generic]

[Blank line]

Re: Dispute of Charges / Appeal of Denial
    Patient: [patient name if available]
    Account / Member ID: [if available]

[Blank line]

[Letter body — letter.content, rendered with whitespace preserved]

[Signature block — already in letter.content, just rendered as-is]
```

### Font and size choices
- Font: `Helvetica` (built into PDFKit, no external font needed)
- Date and Re: line: `fontSize(10)`
- Body text: `fontSize(11)`
- Line height: use `doc.moveDown(0.5)` between paragraphs
- Max line width: respect the 72pt margins — PDFKit wraps automatically

### Rendering the letter body
The `letter.content` field already contains the full letter text including the
date line, recipient address, body, and signature block — all generated by
Claude. Render it directly:

```typescript
doc
  .fontSize(11)
  .font('Helvetica')
  .text(letter.content, {
    align: 'left',
    lineGap: 4
  })
```

The `text()` call with no explicit x/y uses the current position and wraps to
page width automatically. PDFKit handles `\n` line breaks in the string.

### Page header (optional, subtle)
Add a thin horizontal line and small "OverBilled — Patient Dispute Letter" text
at the very top as a watermark-style header, using `doc.fontSize(8).fillColor('#999999')`.
Reset to black `#000000` before rendering the letter body.

---

## 3. Wire Up DownloadPdfButton

### File: `src/components/DownloadPdfButton.tsx`

Replace the current "coming soon" stub with a real download implementation.

### Props
```typescript
interface DownloadPdfButtonProps {
  letterId: string
}
```

### Behaviour
1. On click: set loading state, show "Generating PDF..."
2. Fetch `GET /api/letter/{letterId}/pdf` with `credentials: 'include'`
3. On success:
   - Read the response as a `Blob`
   - Create an object URL: `URL.createObjectURL(blob)`
   - Programmatically click a hidden `<a>` element with `download="dispute-letter.pdf"`
   - Revoke the object URL after click
4. On error: show inline error message "Could not generate PDF. Please try again."
5. Button disabled during loading

### Implementation
```typescript
'use client'
import { useState } from 'react'

export default function DownloadPdfButton({ letterId }: DownloadPdfButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDownload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/letter/${letterId}/pdf`, {
        credentials: 'include'
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dispute-letter.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError('Could not generate PDF. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleDownload}
        disabled={loading}
        className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm
                   font-medium disabled:opacity-50 hover:bg-gray-700
                   transition-colors"
      >
        {loading ? 'Generating PDF...' : 'Download PDF'}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  )
}
```

---

## 4. TypeScript Types

Define the following type (inline in the route file or in `src/lib/types.ts`):

```typescript
interface LetterWithDocument {
  id: string
  content: string
  recipient: 'hospital' | 'insurer'
  created_at: string
  documents: {
    type: 'medical_bill' | 'denial_letter'
    file_name: string
  }
}
```

---

## Automated Testing

After implementing all files, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve errors autonomously,
and report final results.

### Install dependency first
```bash
npm install pdfkit
npm install --save-dev @types/pdfkit
```

### Setup
```bash
npm run dev &
DEV_PID=$!
npx wait-on http://localhost:3000 --timeout 30000
```

### Test 1 — TypeScript compilation
```bash
npx tsc --noEmit
# Expected: no errors
```

### Test 2 — PDF endpoint requires auth
```bash
FAKE_ID="00000000-0000-0000-0000-000000000000"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:3000/api/letter/$FAKE_ID/pdf")
# Expected: 401
echo "Auth guard: $STATUS"
```

### Test 3 — Full PDF generation flow
Create `scripts/test-pdf-download.ts`:

- Creates a test user via service role key
- Inserts a test document row (type: `medical_bill`, status: `analyzed`)
- Inserts a test analysis row (any valid `extracted_data`, any `issues` array)
- Inserts a test letter row with `content` set to a realistic multi-paragraph
  letter string (at least 300 characters, containing `\n\n` paragraph breaks)
- Signs in as the test user to get a session token
- Makes a `GET /api/letter/{letter_id}/pdf` request with `Authorization: Bearer {token}`
- Asserts response status is 200
- Asserts `Content-Type` header is `application/pdf`
- Asserts response body is non-empty (length > 1000 bytes — a minimal PDF is
  always larger than this)
- Asserts response body starts with `%PDF` (the PDF magic bytes, as a Buffer check)
- Asserts `Content-Disposition` header contains `attachment`
- Cleans up all test data (letter, analysis, document, user)
- Reports PASS/FAIL for each assertion

```bash
npx tsx scripts/test-pdf-download.ts
```

### Test 4 — 404 for non-existent letter (authenticated)
Extend `scripts/test-pdf-download.ts` to also:
- Make a request to `/api/letter/00000000-0000-0000-0000-000000000000/pdf`
  with a valid session token
- Assert response status is 404

### Teardown
```bash
kill $DEV_PID
```

---

## Error Resolution Rules

1. **`Cannot find module 'pdfkit'`** — run `npm install pdfkit` and
   `npm install --save-dev @types/pdfkit`, then retry

2. **TypeScript error on PDFDocument import** — use:
   ```typescript
   import PDFDocument from 'pdfkit'
   ```
   If that fails, try:
   ```typescript
   const PDFDocument = require('pdfkit')
   ```
   and add `"esModuleInterop": true` to `tsconfig.json` if not already present

3. **`Response body is not a Uint8Array`** — ensure `streamToBuffer` returns
   a proper `Buffer`. Wrap the resolved value:
   `return new Response(new Uint8Array(pdfBuffer), { ... })`

4. **PDF downloads as 0 bytes** — verify `doc.end()` is called AFTER the
   `bufferPromise = streamToBuffer(doc)` line, not before

5. **`Content-Length` mismatch warning in browser** — remove `Content-Length`
   header if pdfkit output size is unpredictable; the browser will still
   download correctly without it

6. **Letter text overflows page** — PDFKit handles wrapping automatically.
   If text is cut off at the bottom, ensure `doc` is configured without
   `autoFirstPage: false`. The default is `true` (first page added automatically).
   For very long letters PDFKit will add pages automatically.

7. **RLS blocks letter fetch** — verify the route is creating the Supabase
   client with the user's token in global headers (same pattern as analyze route),
   not with the anon key alone

Report each test as PASS or FAIL. Confirm when all pass.
