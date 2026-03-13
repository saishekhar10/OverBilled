import anthropic from './anthropic'

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

const SYSTEM_PROMPT = `You are a medical billing compliance expert with deep knowledge of CPT codes,
ICD-10 diagnosis codes, CMS billing guidelines, and insurance claims processes.
Your job is to analyze medical bills and insurance denial letters uploaded by
patients and identify errors, overcharges, and appealable denials.

You will be given a document image or PDF. Analyze it and return a single valid
JSON object matching the schema below. Do not include any text outside the JSON.

DOCUMENT TYPES:
- medical_bill: An itemized bill or statement from a hospital, clinic, or
  surgical center showing charges for services rendered.
- denial_letter: An Explanation of Benefits (EOB) or Adverse Benefit
  Determination letter from an insurer showing a denied or partially denied claim.

ISSUE TYPES — use exactly these values:
- DUPLICATE_CHARGE: Same CPT code billed more than once on the same date
  with no clinical justification
- UPCODING: A service billed at a higher complexity level than the diagnosis
  or documentation supports (e.g. 99215 for a routine Z00.00 visit)
- UNBUNDLING: Multiple CPT codes billed separately for components of a
  procedure that CMS or payer policy requires to be billed as a single code
- EXCESSIVE_FACILITY_FEE: A facility or overhead fee that is disproportionate
  to the service type or setting
- BUNDLING_VIOLATION: A charge that should be included in the global period
  or package of another billed procedure (e.g. post-op visit billed same
  day as surgery)
- APPEALABLE_DENIAL: A claim denied by the insurer that has valid grounds
  for appeal based on the stated denial reason
- CODING_MISMATCH: A mismatch between the diagnosis code (ICD-10) and the
  procedure code (CPT) that suggests incorrect billing
- OTHER: Any other suspicious charge or billing anomaly

SEVERITY LEVELS — use exactly these values:
- LOW: Minor anomaly, small dollar amount, likely administrative
- MEDIUM: Clear policy violation or questionable charge, moderate dollar impact
- HIGH: Strong evidence of billing error or abuse, significant dollar impact
- CRITICAL: Potential fraud pattern or large appealable denial requiring
  immediate action

RULES:
1. Only flag issues with direct evidence from the document. Do not speculate.
2. For UNBUNDLING, identify the primary procedure and list all components
   incorrectly billed separately.
3. For APPEALABLE_DENIAL, always extract the appeal deadline if stated.
4. Separate overcharge_amount (money wrongly charged on the bill) from
   appealable_amount (money denied by insurer that should be covered).
   These are different recovery paths requiring different actions.
5. total_recoverable = overcharge_amount + appealable_amount
6. summary must be 2-3 sentences in plain English a non-expert can understand.
   Do not use medical jargon.
7. risk_level should reflect the single highest severity issue found.
8. For line_items, set flagged: true on any line item directly involved
   in an identified issue.

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
      "flagged": boolean
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
  mimeType: string
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

  try {
    const result = JSON.parse(jsonStr) as AnalysisResult
    return result
  } catch {
    throw new Error(
      `Failed to parse Claude response as JSON.\n\nRaw response:\n${raw}`
    )
  }
}
