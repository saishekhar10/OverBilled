# Spec 4: Upload Page & Analysis Results

## Overview
The core user-facing flow. A logged-in user lands on the upload page,
selects or drags a medical bill or denial letter, the file is sent to
/api/analyze, and the user is redirected to a results page showing
what was found and how much is recoverable.

This spec covers two pages:
1. `/upload` — file upload UI
2. `/analysis/[id]` — analysis results UI

---

## Files to Create
- `src/app/upload/page.tsx`
- `src/app/analysis/[id]/page.tsx`
- `src/app/analysis/[id]/loading.tsx`
- `src/components/UploadZone.tsx`
- `src/components/IssueCard.tsx`
- `src/components/RiskBadge.tsx`

---

## 1. Upload Page

### Route
`/upload` — protected (middleware already handles this)

### File: `src/app/upload/page.tsx`
Server component that renders the upload layout and includes the
`UploadZone` client component.

```tsx
import UploadZone from '@/components/UploadZone'

export default function UploadPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center
                    justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Upload your bill
        </h1>
        <p className="text-gray-500 mb-8">
          Upload a medical bill or insurance denial letter. We'll analyze
          it and generate a dispute letter ready to send.
        </p>
        <UploadZone />
      </div>
    </div>
  )
}
```

---

## 2. UploadZone Component

### File: `src/components/UploadZone.tsx`
Client component. Handles file selection, drag and drop, and the
POST request to /api/analyze.

### States
The component has four distinct visual states:
1. **idle** — drop zone with upload icon and instructions
2. **selected** — file name shown, ready to submit
3. **uploading** — spinner, "Analyzing your document..." message,
   submit button disabled
4. **error** — error message shown in red, allow retry

### Accepted file types
- application/pdf
- image/jpeg
- image/png
- image/webp

### Max file size
10MB — validate client-side before sending. Show error if exceeded.

### Drag and drop behaviour
- Drag over: border changes to blue, background lightens
- Drag leave: returns to default
- Drop: set file, move to selected state

### File selection behaviour
- Clicking the zone opens the native file picker
- After selection, show the filename and file size
- Show a "Change file" link to reselect

### Submit behaviour
- On submit, create a FormData object with the file appended as 'file'
- POST to /api/analyze with credentials: 'include'
- On success: redirect to /analysis/{analysis_id} using router.push()
- On error: show the error message, allow retry

### Supabase session
The fetch call must include the session cookie — use credentials: 'include'
so the browser sends cookies automatically. Do NOT manually attach a
Bearer token here — the route should be updated to also support cookie-based
auth (see note below).

### Note on /api/analyze auth
The route currently reads a Bearer token from the Authorization header.
Update src/app/api/analyze/route.ts to support BOTH auth methods:
1. First try Authorization header (for API/script access)
2. If no header, fall back to cookie-based session using the
   standard server Supabase client

This makes the route work for both the browser UI and programmatic access.

### Idle state UI
```
┌─────────────────────────────────────────┐
│                                         │
│         ↑ (upload icon)                 │
│                                         │
│    Drag and drop your file here         │
│    or click to browse                   │
│                                         │
│    PDF, JPG, PNG up to 10MB             │
│                                         │
└─────────────────────────────────────────┘
```

### Selected state UI
```
┌─────────────────────────────────────────┐
│  📄 bill_january_2024.pdf               │
│     2.4 MB · Change file                │
│                                         │
│  [ Analyze document ]                   │
└─────────────────────────────────────────┘
```

### Uploading state UI
```
┌─────────────────────────────────────────┐
│  ⟳  Analyzing your document...         │
│     This usually takes 10–20 seconds    │
└─────────────────────────────────────────┘
```

### Styling
- Zone border: dashed, gray by default, blue on drag over
- Border radius: rounded-xl
- Background: white, light blue on drag over
- All text: explicitly dark (text-gray-900 / text-gray-500)
- Button: full width, dark background, white text, disabled + opacity
  during upload
- Error: red border on zone, red text below

---

## 3. Analysis Results Page

### Route
`/analysis/[id]` — protected

### File: `src/app/analysis/[id]/page.tsx`
Server component. Fetches the analysis and document from Supabase
using the id param, renders the results.

### Data fetching
```typescript
// Fetch analysis
const { data: analysis } = await supabase
  .from('analyses')
  .select('*, documents(*)')
  .eq('id', params.id)
  .single()
```

If no analysis found or user doesn't own it (RLS will block), redirect
to /dashboard.

### Layout
```
┌─────────────────────────────────────────┐
│  ← Back to dashboard                    │
│                                         │
│  [RISK BADGE]  $X,XXX recoverable       │
│                                         │
│  Summary text here in plain English     │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Issues found (N)                       │
│                                         │
│  [IssueCard]                            │
│  [IssueCard]                            │
│  [IssueCard]                            │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  [ Generate dispute letter ]  →         │
│                                         │
└─────────────────────────────────────────┘
```

### "Generate dispute letter" button
For now this button should show a "Coming soon" toast or alert.
It will be wired up in Spec 5.

---

## 4. RiskBadge Component

### File: `src/components/RiskBadge.tsx`
Displays the risk level as a colored pill badge.

| Value    | Background      | Text       | Label    |
|----------|----------------|------------|----------|
| LOW      | bg-green-100   | text-green-800  | Low Risk |
| MEDIUM   | bg-yellow-100  | text-yellow-800 | Medium Risk |
| HIGH     | bg-orange-100  | text-orange-800 | High Risk |
| CRITICAL | bg-red-100     | text-red-800    | Critical |

Props: `{ level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }`

---

## 5. IssueCard Component

### File: `src/components/IssueCard.tsx`
Displays a single issue found in the analysis.

### Props
```typescript
interface IssueCardProps {
  issue: {
    id: string
    type: string
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    title: string
    description: string
    amount_at_risk: number
    action_required: string
    deadline: string | null
    cpt_codes: string[]
  }
}
```

### Layout
```
┌─────────────────────────────────────────┐
│  [SEVERITY BADGE]          $XXX at risk │
│                                         │
│  Issue title here                       │
│                                         │
│  Description text explaining the        │
│  issue in plain English.                │
│                                         │
│  Action: What the user should do        │
│                                         │
│  ⚠ Deadline: May 7, 2025  (if set)     │
│                                         │
│  CPT codes: 71046, 99285               │
└─────────────────────────────────────────┘
```

### Styling
- White card, subtle border, rounded-xl, shadow-sm
- Severity badge: use RiskBadge component
- Amount at risk: bold, colored based on severity
- Deadline: shown in red with warning icon if present
- CPT codes: small gray pills
- All text explicitly dark

---

## 6. Loading State

### File: `src/app/analysis/[id]/loading.tsx`
Shown by Next.js automatically while the server component fetches data.

Simple centered spinner with "Loading your analysis..." text.

---

## Automated Testing

After implementing all files, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve errors, report results.

### Setup
```bash
npm run dev &
DEV_PID=$!
npx wait-on http://localhost:3000 --timeout 30000
```

### Test 1 — Upload page requires auth
```bash
# Should redirect unauthenticated user
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3000/upload)
# Expected: 307
```

### Test 2 — Upload page renders for authenticated user
Create `scripts/test-upload-page.ts`:
- Creates a test user via service role key
- Signs in to get a session cookie
- Makes a GET request to /upload with the session cookie
- Asserts the response contains "Upload your bill" or "Drag and drop"
- Deletes the test user after

### Test 3 — Full upload flow via API
Extend `scripts/test-upload-page.ts` to also:
- POST bill_1_er_visit.pdf to /api/analyze with the session cookie
  using credentials (attach cookie manually in the test script)
- Assert response contains success: true, analysis_id, document_id
- Assert analysis_id is a valid UUID
- Fetch /analysis/{analysis_id} and assert it returns 200
- Delete the test user and associated data after

### Test 4 — TypeScript compilation
```bash
npx tsc --noEmit
# Expected: no errors
```

### Teardown
```bash
kill $DEV_PID
```

### Error Resolution Rules
1. **TypeScript errors** — run `npx tsc --noEmit`, fix all errors, retest
2. **Upload returns 401** — the /api/analyze route needs cookie-based
   auth fallback as described in the UploadZone note above. Add it and retest.
3. **Analysis page shows blank** — check that the issues JSONB column
   is being parsed correctly — use `JSON.parse()` if needed
4. **wait-on not found** — `npm install --save-dev wait-on` then retry
5. **Redirect not 307** — check middleware matcher includes /upload

Report each test as PASS or FAIL with actual vs expected.
Confirm when all tests pass and implementation is complete.
