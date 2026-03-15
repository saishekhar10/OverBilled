# Spec 8: Fee Schedule Integration

## Overview
Wires the CMS Medicare fee schedule data (added in Spec 7) into the analysis
pipeline. This spec covers three things:

1. Adding state and county input fields to the upload page so the user
   explicitly provides their provider location before submitting
2. Passing that location through the API to the analysis layer
3. Using `lookupMedicareRate` from `src/lib/fee-schedule.ts` to enrich
   each CPT code on the bill with its Medicare allowed amount, then
   passing those benchmark numbers to Claude so the analysis is grounded
   in real price data rather than general intuition

After this spec the analysis results will include the Medicare allowed
amount for each procedure alongside what the hospital charged, and Claude's
issue descriptions and summary will reference specific dollar figures.

---

## Files to Create
- `scripts/test-fee-schedule-integration.ts`

## Files to Update
- `src/components/UploadZone.tsx`
- `src/app/api/analyze/route.ts`
- `src/lib/analyze.ts`
- `src/app/analysis/[id]/page.tsx`

---

## 1. UploadZone — Add State and County Inputs

### File: `src/components/UploadZone.tsx`

Add two new required fields above the file drop zone:
- **State** — a dropdown (`<select>`) of all 50 US states plus DC,
  using two-letter abbreviations as values (e.g. `TX`, `CA`)
- **County** — a free text input

Both fields are required. The Analyze button must remain disabled until
all three inputs are filled: state, county, and file.

### New state variables
Add two new state variables:
```typescript
const [providerState, setProviderState] = useState('')
const [providerCounty, setProviderCounty] = useState('')
```

### Validation
Before submitting, validate:
- `providerState` is not empty
- `providerCounty` is not empty
- A file has been selected

If any are missing, show an inline error: "Please select a file and enter
the provider's state and county."

### FormData changes
When submitting, append the new fields to the FormData:
```typescript
formData.append('file', file)
formData.append('provider_state', providerState.trim().toUpperCase())
formData.append('provider_county', providerCounty.trim().toUpperCase())
```

### UI layout
Place the state and county fields above the file drop zone. The layout
should look like:

```
┌─────────────────────────────────────────┐
│  Provider location                      │
│                                         │
│  State                  County          │
│  [dropdown ▼]           [text input   ] │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │  Drag and drop your file here   │   │
│  │  or click to browse             │   │
│  │  PDF, JPG, PNG up to 10MB       │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### State dropdown values
Use this exact list for the dropdown options. Value is the two-letter
abbreviation, label is the full state name:

```typescript
const US_STATES = [
  { value: '', label: 'Select state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'DC', label: 'District of Columbia' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' },
]
```

### Styling
- State and county fields sit side by side on the same row
- State dropdown: approximately 40% width
- County input: approximately 55% width, small gap between them
- Both use the same input styling as the auth forms — border, rounded,
  focus ring, dark text
- Label above each field: small, gray, medium weight
- Section label "Provider location" above both fields
- All text explicitly dark (text-gray-900 / text-gray-700)

---

## 2. API Route — Accept and Forward Location

### File: `src/app/api/analyze/route.ts`

### Changes required

**Step 1 — Extract new fields from FormData**
After extracting the file, extract the two new fields:
```typescript
const providerState = (formData.get('provider_state') as string)?.trim().toUpperCase()
const providerCounty = (formData.get('provider_county') as string)?.trim().toUpperCase()
```

**Step 2 — Validate**
If either field is missing or empty, return 400:
```typescript
if (!providerState || !providerCounty) {
  return NextResponse.json(
    { error: 'provider_state and provider_county are required' },
    { status: 400 }
  )
}
```

**Step 3 — Pass to analyzeDocument**
Update the call to `analyzeDocument` to pass the location:
```typescript
result = await analyzeDocument(buffer, file.type, providerState, providerCounty)
```

No other changes to the route are needed. The location fields will be
included in the returned `AnalysisResult` and stored as part of
`extracted_data` automatically.

---

## 3. Analysis Library — Integrate Fee Schedule Lookup

### File: `src/lib/analyze.ts`

This is the most significant change in this spec. The analysis now runs
in two stages instead of one.

**Stage 1** — Claude reads the document, extracts structured data, and
identifies structural billing errors only. Claude is explicitly told NOT
to assess prices — that happens in code with real data.

**Stage 2** — After Claude returns, the code calls `lookupMedicareRate`
for each line item CPT code, attaches the Medicare benchmark to each
line item, and generates additional OVERCHARGE issues where the charge
is more than 3x the Medicare rate.

### Add this import at the top of analyze.ts
```typescript
import { lookupMedicareRate } from './fee-schedule'
```

### Interface changes

Add `provider_state` and `provider_county` to `AnalysisResult`:
```typescript
export interface AnalysisResult {
  document_type: 'medical_bill' | 'denial_letter'
  provider_state: string
  provider_county: string
  patient: {
    name: string
    dob: string | null
    member_id: string | null
  }
  // ... rest of interface unchanged
}
```

Update `LineItem` to include Medicare benchmark fields:
```typescript
export interface LineItem {
  cpt_code: string
  description: string
  date: string | null
  quantity: number
  amount: number
  flagged: boolean
  // Added by fee schedule enrichment after Claude call
  medicare_facility_amount: number | null
  medicare_non_facility_amount: number | null
  medicare_locality: string | null
  price_ratio: number | null  // amount / medicare_facility_amount
}
```

### Updated function signature
```typescript
export async function analyzeDocument(
  fileBuffer: Buffer,
  mimeType: string,
  providerState: string,
  providerCounty: string
): Promise<AnalysisResult>
```

### Updated system prompt

Replace the existing `SYSTEM_PROMPT` constant with the following.
The critical change is removing all price assessment instructions —
Claude now focuses only on extraction and structural error detection:

```
You are a medical billing expert. Your job is to extract structured data
from a medical bill or insurance denial letter and identify structural
billing errors.

You will be given a document image or PDF. Analyze it and return a single
valid JSON object matching the schema below. Do not include any text
outside the JSON.

DOCUMENT TYPES:
- medical_bill: An itemized bill or statement from a hospital, clinic, or
  surgical center showing charges for services rendered.
- denial_letter: An Explanation of Benefits (EOB) or Adverse Benefit
  Determination letter from an insurer showing a denied or partially
  denied claim.

YOUR JOB IN THIS ANALYSIS:
Extract all structured data accurately. Identify only structural billing
errors that you can detect directly from the document. Do not attempt
to assess whether prices are reasonable or compare them to any benchmark.
Price comparison will be handled separately with real CMS data.

STRUCTURAL ERRORS TO IDENTIFY:
- DUPLICATE_CHARGE: The exact same CPT code billed more than once on the
  same date of service with no clinical justification
- UNBUNDLING: Multiple CPT codes billed separately for components of a
  procedure that CMS requires to be billed as a single bundled code
- BUNDLING_VIOLATION: A charge billed separately that should be included
  in the global period of another billed procedure (e.g. a post-op visit
  billed on the same day as surgery)
- UPCODING: A service billed at a higher complexity level than the
  documented diagnosis or clinical notes support
- CODING_MISMATCH: A clear mismatch between the ICD-10 diagnosis code
  and the CPT procedure code that indicates incorrect billing
- APPEALABLE_DENIAL: For denial letters only — a denied claim with valid
  grounds for appeal based on the stated denial reason
- OTHER: Any other clear billing anomaly visible in the document

DO NOT flag a line item as suspicious purely because the charge amount
seems high. Price benchmarking is handled externally with real data.

RULES:
1. Only flag issues with direct evidence from the document
2. For UNBUNDLING identify the primary procedure and all components
   incorrectly billed separately
3. For APPEALABLE_DENIAL always extract the appeal deadline if stated
4. summary must be 2-3 sentences in plain English a non-expert can
   understand. Do not mention price comparisons — those will be added
   after. Focus only on what structural errors were found.
5. risk_level should reflect the highest severity structural issue found.
   If no structural issues are found, use LOW.
6. Set flagged: true on any line item directly involved in an identified
   structural issue
7. Extract every line item visible on the bill — CPT code, description,
   date, quantity, and amount
8. Leave medicare_facility_amount, medicare_non_facility_amount,
   medicare_locality, and price_ratio as null on all line items.
   These fields will be populated by the calling code after you return.

Return this exact JSON schema:

{
  "document_type": "medical_bill" | "denial_letter",
  "patient": {
    "name": "string",
    "dob": "string | null",
    "member_id": "string | null"
  },
  "provider": {
    "name": "string",
    "address": "string | null"
  },
  "insurer": {
    "name": "string | null",
    "claim_number": "string | null",
    "group_number": "string | null"
  },
  "account_number": "string | null",
  "service_date": "string | null",
  "statement_date": "string | null",
  "financials": {
    "total_billed": number,
    "insurance_paid": number,
    "adjustments": number,
    "patient_owes": number,
    "overcharge_amount": number,
    "appealable_amount": number
  },
  "line_items": [
    {
      "cpt_code": "string",
      "description": "string",
      "date": "string | null",
      "quantity": number,
      "amount": number,
      "flagged": boolean,
      "medicare_facility_amount": null,
      "medicare_non_facility_amount": null,
      "medicare_locality": null,
      "price_ratio": null
    }
  ],
  "denial": {
    "denial_code": "string | null",
    "denial_reason": "string",
    "appeal_deadline": "string | null",
    "services_denied": [
      {
        "cpt_code": "string",
        "description": "string",
        "amount": number
      }
    ]
  } | null,
  "issues": [
    {
      "id": "string",
      "type": "DUPLICATE_CHARGE | UPCODING | UNBUNDLING | EXCESSIVE_FACILITY_FEE | BUNDLING_VIOLATION | APPEALABLE_DENIAL | CODING_MISMATCH | OTHER",
      "severity": "LOW | MEDIUM | HIGH | CRITICAL",
      "cpt_codes": ["string"],
      "title": "string",
      "description": "string",
      "amount_at_risk": number,
      "action_required": "string",
      "deadline": "string | null"
    }
  ],
  "risk_level": "LOW | MEDIUM | HIGH | CRITICAL",
  "summary": "string",
  "total_recoverable": number
}
```

### Fee schedule enrichment step

After the Claude response is parsed and before the function returns,
add the following enrichment logic. Insert this after the `JSON.parse`
call that produces `result`:

```typescript
// Stage 2: Enrich line items with Medicare benchmark data
const enrichedLineItems = await Promise.all(
  result.line_items.map(async (item) => {
    if (!item.cpt_code) return item

    const addressString = `${providerCounty}, ${providerState}`

    try {
      const rate = await lookupMedicareRate(item.cpt_code, addressString)

      if (!rate.found) return item

      const priceRatio =
        rate.facility_amount && item.amount > 0
          ? Math.round((item.amount / rate.facility_amount) * 100) / 100
          : null

      // Flag items where charge is more than 3x Medicare rate
      const shouldFlag = priceRatio !== null && priceRatio > 3

      return {
        ...item,
        medicare_facility_amount: rate.facility_amount ?? null,
        medicare_non_facility_amount: rate.non_facility_amount ?? null,
        medicare_locality: rate.locality_name ?? null,
        price_ratio: priceRatio,
        flagged: item.flagged || shouldFlag,
      }
    } catch {
      return item
    }
  })
)

// Generate OVERCHARGE issues for items > 3x Medicare rate
// only where no structural issue already exists for that CPT code
const existingIssueCptCodes = new Set(
  result.issues.flatMap((i) => i.cpt_codes)
)

const overchargeIssues: Issue[] = enrichedLineItems
  .filter(
    (item) =>
      item.price_ratio !== null &&
      item.price_ratio > 3 &&
      !existingIssueCptCodes.has(item.cpt_code)
  )
  .map((item) => ({
    id: `overcharge-${item.cpt_code}`,
    type: 'OTHER' as const,
    severity: (item.price_ratio! > 5 ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
    cpt_codes: [item.cpt_code],
    title: `Charge significantly above Medicare benchmark`,
    description: `CPT ${item.cpt_code} (${item.description}) was billed at $${item.amount.toFixed(2)}. The Medicare allowed amount for this procedure in ${item.medicare_locality} is $${item.medicare_facility_amount!.toFixed(2)}, making this charge ${item.price_ratio!.toFixed(1)}x the Medicare benchmark.`,
    amount_at_risk:
      Math.round((item.amount - item.medicare_facility_amount!) * 100) / 100,
    action_required: `Request itemized justification for this charge and ask the hospital to review and adjust to a reasonable rate.`,
    deadline: null,
  }))

const allIssues = [...result.issues, ...overchargeIssues]

const totalRecoverable = allIssues.reduce(
  (sum, issue) => sum + (issue.amount_at_risk || 0),
  0
)

const severityRank: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
}
const highestSeverity = allIssues.reduce(
  (highest, issue) =>
    severityRank[issue.severity] > severityRank[highest]
      ? issue.severity
      : highest,
  result.risk_level
) as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

return {
  ...result,
  provider_state: providerState,
  provider_county: providerCounty,
  line_items: enrichedLineItems,
  issues: allIssues,
  total_recoverable: Math.round(totalRecoverable * 100) / 100,
  risk_level: highestSeverity,
}
```

---

## 4. Analysis Results Page — Show Medicare Benchmark Summary

### File: `src/app/analysis/[id]/page.tsx`

Add a Medicare benchmark summary block between the issues list and the
Generate Letter button. Only render it if at least one line item has
Medicare data.

```tsx
{(() => {
  const lineItems = (analysis.extracted_data as {
    line_items?: Array<{
      cpt_code: string
      amount: number
      medicare_facility_amount: number | null
      price_ratio: number | null
    }>
  })?.line_items ?? []

  const enriched = lineItems.filter(
    (li) => li.medicare_facility_amount !== null
  )
  if (enriched.length === 0) return null

  const maxRatio = Math.max(...enriched.map((li) => li.price_ratio ?? 0))

  return (
    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900">
      <p className="font-medium mb-1">Medicare benchmark comparison</p>
      <p className="text-blue-700">
        {enriched.length} of {lineItems.length} procedures matched against
        the 2026 CMS Medicare Physician Fee Schedule.
        {maxRatio > 1 &&
          ` Highest charge ratio: ${maxRatio.toFixed(1)}x the Medicare rate.`}
      </p>
    </div>
  )
})()}
```

Place this block between the closing `</div>` of the issues section and
the `<hr />` separator above the Generate Letter button.

---

## Automated Testing

After implementing all changes, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve errors, and
report final results.

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

### Test 2 — Validation rejects missing location fields

Create `scripts/test-fee-schedule-integration.ts`:

- Creates a test user via service role key
- Signs in to get a Bearer token
- POSTs to `/api/analyze` with a valid PDF but WITHOUT `provider_state`
  and `provider_county`
- Asserts response status is 400
- Reports PASS or FAIL

### Test 3 — Full analysis flow with location data

Extend the same test script to:
- POST `scripts/test_bills/bill_1_er_visit.pdf` to `/api/analyze` with
  `provider_state=TX` and `provider_county=HARRIS` using Bearer token
- Assert response contains `success: true`
- Assert `analysis.provider_state === 'TX'`
- Assert `analysis.provider_county === 'HARRIS'`
- Assert `analysis.line_items` is an array with at least one item
- Assert at least one line item has a non-null `medicare_facility_amount`
- Assert at least one line item has a non-null `price_ratio`
- Assert `analysis.issues` is an array
- Clean up test user and all associated data after

### Test 4 — TypeScript compilation after all changes
```bash
npx tsc --noEmit
# Expected: no errors
```

### Teardown
```bash
kill $DEV_PID
```

### Error Resolution Rules

1. **TypeScript errors on LineItem** — ensure `medicare_facility_amount`,
   `medicare_non_facility_amount`, `medicare_locality`, and `price_ratio`
   are all added to the `LineItem` interface in `analyze.ts` as
   `number | null` or `string | null` respectively.

2. **TypeScript errors on AnalysisResult** — ensure `provider_state` and
   `provider_county` are added as `string` (not optional) to the
   `AnalysisResult` interface.

3. **`lookupMedicareRate` import error** — check the exact export name
   in `src/lib/fee-schedule.ts` as Claude Code may have exported it
   under a different name. Use whatever name is actually exported.

4. **400 on valid POST** — verify that `provider_state` and
   `provider_county` are being appended to FormData in `UploadZone.tsx`
   and extracted correctly in the route handler using `formData.get()`.

5. **All line items have null `medicare_facility_amount`** — the
   enrichment loop is running but lookups are failing silently. Add a
   temporary `console.log` inside the enrichment loop to log the CPT
   code and rate result for the first item. Verify the fee_schedule
   table has data by running `npx tsx scripts/test-fee-schedule.ts`.

6. **`wait-on` not found** — run `npm install --save-dev wait-on`
   then retry.

Report each test as PASS or FAIL with actual vs expected values.
Confirm when all tests pass and implementation is complete.
