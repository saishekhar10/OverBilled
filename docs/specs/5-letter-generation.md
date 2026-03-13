# Spec 5: Letter Generation

## Overview
Takes an analysis that has already been saved to the database and generates
a dispute or appeal letter tailored to the specific issues found. This is
the second and final Claude API call in the product pipeline.

Two components:
1. `POST /api/generate-letter` — the API route that calls Claude and saves
   the letter
2. `GenerateLetterButton` — wired up to call the route and redirect to the
   letter view page

---

## Files to Create
- `src/app/api/generate-letter/route.ts`
- `src/app/letter/[id]/page.tsx`
- `src/app/letter/[id]/loading.tsx`
- `src/lib/generate-letter.ts`

## Files to Update
- `src/components/GenerateLetterButton.tsx` — wire up to the real route

---

## 1. Letter Generation Prompt

This is the system prompt for the Claude letter generation call.
Store it as a constant in `src/lib/generate-letter.ts`.

```
You are an expert patient advocate and medical billing attorney with
extensive experience writing dispute letters and insurance appeal letters
on behalf of patients. Your letters are firm, factual, and professional.
They cite specific billing codes, dollar amounts, and applicable regulations.
They do not use aggressive or threatening language. They make a clear,
specific request and provide a reasonable deadline for response.

You will be given a JSON object containing:
- document_type: "medical_bill" or "denial_letter"
- patient: patient name and details
- provider: the healthcare provider or facility
- insurer: the insurance company details (may be null for medical bills)
- issues: an array of billing issues identified by automated analysis
- financials: billing amounts and totals

Write a single, complete dispute or appeal letter based on this information.

LETTER RULES:
1. Address the letter to the correct recipient:
   - For medical_bill: address to the billing department of the provider
   - For denial_letter: address to the appeals department of the insurer
2. Open with patient identifying information: name, member ID or account
   number, date of service
3. Clearly state the purpose in the first paragraph — dispute of charges
   or appeal of denial
4. Dedicate one paragraph per issue. Each paragraph must:
   - Name the specific CPT code(s) involved
   - State the dollar amount at risk
   - Explain why the charge or denial is improper, citing CMS guidelines,
     bundling rules, or the specific denial reason as appropriate
   - Make a specific request (remove charge, rebill correctly, reconsider
     denial, etc.)
5. If any issue has a deadline, include a sentence noting the urgency
6. Close with a clear summary of total amount in dispute and a request
   for written response within 30 days
7. End with a signature block: "Sincerely, [Patient Name]" followed by
   contact info placeholder lines
8. Do not invent clinical facts not present in the data
9. Do not use placeholders like [INSERT DATE] — use the actual dates
   from the data. Use today's date for the letter date.
10. Write in first person — the letter is from the patient
11. Keep the tone professional and assertive, not emotional or accusatory
12. Total length: 400–700 words. No more.

Return only the letter text. No JSON. No commentary. Just the letter.
```

---

## 2. generateLetter Function

### File: `src/lib/generate-letter.ts`

Export an async function `generateLetter` that:

```typescript
export async function generateLetter(
  analysis: AnalysisResult,
  documentType: 'medical_bill' | 'denial_letter'
): Promise<string>
```

- Creates a user message containing the analysis data as formatted JSON
- Sends to Claude claude-sonnet-4-5 (use Sonnet here, not Haiku —
  letter quality matters more than cost at this step)
- max_tokens: 2048
- Returns the raw letter text string
- Throws a descriptive error if the API call fails

The user message format:
```
Generate a dispute letter for the following analysis:

{
  "document_type": "...",
  "patient": { ... },
  "provider": { ... },
  "insurer": { ... },
  "financials": { ... },
  "issues": [ ... ]
}
```

---

## 3. POST /api/generate-letter Route

### File: `src/app/api/generate-letter/route.ts`

### Request body (JSON)
```json
{ "analysis_id": "uuid" }
```

### Auth
Same pattern as /api/analyze — check Authorization header first,
fall back to cookie session. Return 401 if no valid session.

### Step-by-step logic

**Step 1 — Validate input**
- Parse request body
- If no analysis_id, return 400

**Step 2 — Fetch analysis from database**
```typescript
const { data: analysis } = await supabase
  .from('analyses')
  .select('*, documents(*)')
  .eq('id', analysisId)
  .single()
```
- If not found, return 404
- RLS ensures the user can only access their own analyses

**Step 3 — Check if letter already exists**
```typescript
const { data: existing } = await supabase
  .from('letters')
  .select('id')
  .eq('analysis_id', analysisId)
  .single()
```
- If a letter already exists for this analysis, return the existing
  letter_id instead of generating a new one:
  `return { letter_id: existing.id, cached: true }`

**Step 4 — Build the analysis payload for Claude**
Reconstruct the full AnalysisResult from the database:
```typescript
const payload = {
  document_type: analysis.documents.type,
  ...analysis.extracted_data,
  issues: analysis.issues,
  summary: analysis.summary
}
```

**Step 5 — Call generateLetter()**
- Pass the payload and document_type
- If it throws, return 500

**Step 6 — Save letter to database**
```typescript
await supabase.from('letters').insert({
  document_id: analysis.document_id,
  analysis_id: analysisId,
  recipient: analysis.documents.type === 'denial_letter'
    ? 'insurer'
    : 'hospital',
  content: letterContent
})
```

**Step 7 — Return success**
```json
{
  "success": true,
  "letter_id": "uuid",
  "cached": false
}
```

---

## 4. Letter View Page

### File: `src/app/letter/[id]/page.tsx`
Server component. Fetches the letter from the database by ID and
renders it.

### Data fetching
```typescript
const { data: letter } = await supabase
  .from('letters')
  .select('*, documents(*), analyses(*)')
  .eq('id', params.id)
  .single()
```
If not found or user doesn't own it, redirect to /dashboard.

### Layout
```
┌─────────────────────────────────────────┐
│  ← Back to analysis                     │
│                                         │
│  Your dispute letter                    │
│  [recipient badge: Hospital / Insurer]  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │                                   │  │
│  │  [Letter content rendered here    │  │
│  │   in a readable serif-style font, │  │
│  │   white background, like a real   │  │
│  │   document]                       │  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  [ Copy letter ]  [ Download PDF ]      │
│                                         │
└─────────────────────────────────────────┘
```

### "Copy letter" button
Client component. Uses `navigator.clipboard.writeText(letter.content)`.
Shows "Copied!" confirmation for 2 seconds after click.

### "Download PDF" button
For now show a "Coming soon" alert. PDF generation is Spec 6.

### Letter rendering
- Render in a white card with padding
- Use `whitespace-pre-wrap` to preserve line breaks
- Font: font-mono or a readable body font — the letter should look
  like a real document, not a chat message
- Max width: max-w-2xl centered

### Loading state
`src/app/letter/[id]/loading.tsx` — simple spinner, "Preparing your
letter..." text

---

## 5. Wire up GenerateLetterButton

### File: `src/components/GenerateLetterButton.tsx`
Replace the "Coming soon" alert with the real implementation.

### Behaviour
1. On click: set loading state, show "Generating letter..."
2. POST to /api/generate-letter with `{ analysis_id }`
3. On success: redirect to /letter/{letter_id} using router.push()
4. On error: show error message inline, allow retry
5. Button disabled during loading

### Props
```typescript
interface GenerateLetterButtonProps {
  analysisId: string
}
```

---

## Automated Testing

After implementing all files, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve errors autonomously,
and report final results.

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

### Test 2 — Full letter generation flow
Create `scripts/test-letter-generation.ts`:

- Creates a test user via service role key
- Inserts a test document row into documents table
- Inserts a test analysis row into analyses table using the real
  extracted data from bill_1_er_visit.pdf analysis
  (hardcode a realistic payload matching the AnalysisResult schema)
- POSTs to /api/generate-letter with the analysis_id
- Asserts response contains success: true and letter_id
- Fetches the letter row from the letters table
- Asserts letter.content is a non-empty string over 200 characters
- Asserts letter.content contains the patient name from the analysis
- Asserts letter.recipient is either 'hospital' or 'insurer'
- Calls the endpoint a second time with the same analysis_id
- Asserts cached: true is returned (no duplicate letter created)
- Cleans up all test data (letter, analysis, document, user)
- Reports PASS/FAIL for each assertion

### Test 3 — Letter view page requires auth
```bash
# Create a fake UUID
FAKE_ID="00000000-0000-0000-0000-000000000000"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:3000/letter/$FAKE_ID")
# Expected: 307 (redirect to login)
```

### Teardown
```bash
kill $DEV_PID
```

### Error Resolution Rules
1. **TypeScript errors** — run `npx tsc --noEmit`, fix all type errors, retest
2. **generateLetter returns empty string** — check that the Anthropic client
   is initialized correctly and the model name is valid
3. **Letter not saved to DB** — check the letters table insert, ensure
   document_id and analysis_id foreign keys exist in the test data
4. **Cached check not working** — verify the .single() query on letters
   table uses analysis_id not document_id
5. **Letter view page not redirecting** — check middleware matcher includes
   /letter/:path*

Report each test as PASS or FAIL. Confirm when all pass.