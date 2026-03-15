import anthropic from './anthropic'
import { lookupMedicareRate } from './fee-schedule'

export interface ServiceDenied {
  cpt_code: string
  description: string
  amount: number
}

export interface Denial {
  denial_code: string | null
  denial_reason: string
  appeal_deadline: string | null
  services_denied: ServiceDenied[]
}

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

export interface Issue {
  id: string
  type:
    | 'DUPLICATE_CHARGE'
    | 'UPCODING'
    | 'UNBUNDLING'
    | 'EXCESSIVE_FACILITY_FEE'
    | 'BUNDLING_VIOLATION'
    | 'APPEALABLE_DENIAL'
    | 'CODING_MISMATCH'
    | 'OTHER'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  cpt_codes: string[]
  title: string
  description: string
  amount_at_risk: number
  action_required: string
  deadline: string | null
}

export interface AnalysisResult {
  document_type: 'medical_bill' | 'denial_letter'
  provider_state: string
  provider_county: string
  patient: {
    name: string
    dob: string | null
    member_id: string | null
  }
  provider: {
    name: string
    address: string | null
  }
  insurer: {
    name: string | null
    claim_number: string | null
    group_number: string | null
  }
  account_number: string | null
  service_date: string | null
  statement_date: string | null
  financials: {
    total_billed: number
    insurance_paid: number
    adjustments: number
    patient_owes: number
    overcharge_amount: number
    appealable_amount: number
  }
  line_items: LineItem[]
  denial: Denial | null
  issues: Issue[]
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  summary: string
  total_recoverable: number
}

const SYSTEM_PROMPT = `You are a medical billing expert. Your job is to extract structured data
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
}`

export async function analyzeDocument(
  fileBuffer: Buffer,
  mimeType: string,
  providerState: string,
  providerCounty: string
): Promise<AnalysisResult> {
  const base64 = fileBuffer.toString('base64')

  const supportedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const isPdf = mimeType === 'application/pdf'
  const isImage = supportedImageTypes.includes(mimeType)

  if (!isPdf && !isImage) {
    throw new Error(`Unsupported MIME type: ${mimeType}. Supported types: PDF and images (JPEG, PNG, GIF, WebP).`)
  }

  const contentSource = isPdf
    ? ({ type: 'base64', media_type: 'application/pdf', data: base64 } as const)
    : ({ type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 } as const)

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: isPdf ? 'document' : 'image',
            source: contentSource,
          } as never,
          {
            type: 'text',
            text: 'Please analyze this medical document and return the JSON analysis.',
          },
        ],
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response received from Claude.')
  }

  const raw = textBlock.text.trim()

  // Strip markdown code fences if present
  const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  let result: AnalysisResult
  try {
    result = JSON.parse(jsonStr) as AnalysisResult
  } catch {
    throw new Error(
      `Failed to parse Claude response as JSON.\n\nRaw response:\n${raw}`
    )
  }

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
      type: 'EXCESSIVE_FACILITY_FEE' as const,
      severity: (item.price_ratio! > 5 ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
      cpt_codes: [item.cpt_code],
      title: `Charge significantly above Medicare benchmark`,
      description: `CPT ${item.cpt_code} (${item.description}) was billed at $${item.amount.toFixed(2)}, which is ${item.price_ratio!.toFixed(1)}x the Medicare reference rate of $${item.medicare_facility_amount!.toFixed(2)} in ${item.medicare_locality}. Medicare rates are a reference point, not a cap — but this gap is large enough to warrant scrutiny.`,
      amount_at_risk:
        Math.round((item.amount - item.medicare_facility_amount!) * 100) / 100,
      action_required: `Request an itemized explanation for this charge. Use the Medicare benchmark as context when negotiating, not as the guaranteed outcome.`,
      deadline: null,
    }))

  const allIssues = [...result.issues, ...overchargeIssues]

  // Only count structural errors toward the recoverable figure.
  // Benchmark-comparison issues (EXCESSIVE_FACILITY_FEE) are context — patients
  // are not entitled to Medicare rates and recovery is not guaranteed.
  const STRUCTURAL_TYPES = new Set<Issue['type']>([
    'DUPLICATE_CHARGE',
    'UPCODING',
    'UNBUNDLING',
    'BUNDLING_VIOLATION',
    'CODING_MISMATCH',
    'APPEALABLE_DENIAL',
    'OTHER',
  ])

  const totalRecoverable = allIssues
    .filter((issue) => STRUCTURAL_TYPES.has(issue.type))
    .reduce((sum, issue) => sum + (issue.amount_at_risk || 0), 0)

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
}
