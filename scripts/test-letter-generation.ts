import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const BASE_URL = 'http://localhost:3000'

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TEST_EMAIL = `test-letter-${Date.now()}@example.com`
const TEST_PASSWORD = 'testpassword123!'

let passed = 0
let failed = 0
let userId: string | null = null
let documentId: string | null = null
let analysisId: string | null = null
let letterId: string | null = null

function pass(msg: string) { console.log(`PASS: ${msg}`); passed++ }
function fail(msg: string) { console.log(`FAIL: ${msg}`); failed++ }
function isUUID(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

const TEST_PATIENT_NAME = 'Jane Smith'

// Realistic extracted_data payload matching AnalysisResult schema (bill_1_er_visit scenario)
const EXTRACTED_DATA = {
  document_type: 'medical_bill',
  patient: {
    name: TEST_PATIENT_NAME,
    dob: '1985-03-12',
    member_id: 'UHC-887234',
  },
  provider: {
    name: 'Metro General Hospital',
    address: '1234 Medical Center Dr, Austin, TX 78701',
  },
  insurer: {
    name: 'UnitedHealthcare',
    claim_number: 'CLM-2024-009182',
    group_number: 'GRP-4421',
  },
  account_number: 'ACC-20240115-001',
  service_date: '2024-01-15',
  statement_date: '2024-02-01',
  financials: {
    total_billed: 4850.00,
    insurance_paid: 2100.00,
    adjustments: 350.00,
    patient_owes: 2400.00,
    overcharge_amount: 850.00,
    appealable_amount: 0,
  },
  line_items: [
    { cpt_code: '99285', description: 'Emergency department visit, high complexity', date: '2024-01-15', quantity: 1, amount: 1200.00, flagged: true },
    { cpt_code: '71046', description: 'Chest X-ray, 2 views', date: '2024-01-15', quantity: 2, amount: 600.00, flagged: true },
    { cpt_code: '36415', description: 'Routine venipuncture', date: '2024-01-15', quantity: 1, amount: 45.00, flagged: false },
    { cpt_code: '99000', description: 'Handling specimen', date: '2024-01-15', quantity: 1, amount: 75.00, flagged: true },
    { cpt_code: '93005', description: 'Electrocardiogram', date: '2024-01-15', quantity: 1, amount: 280.00, flagged: false },
  ],
  denial: null,
  risk_level: 'HIGH' as const,
  total_recoverable: 850.00,
}

const TEST_ISSUES = [
  {
    id: 'issue-001',
    type: 'DUPLICATE_CHARGE',
    severity: 'HIGH' as const,
    cpt_codes: ['71046'],
    title: 'Duplicate chest X-ray charge',
    description: 'CPT 71046 (chest X-ray, 2 views) was billed twice on the same date of service without clinical justification for repeat imaging.',
    amount_at_risk: 600.00,
    action_required: 'Request removal of duplicate line item and credit of $600.00.',
    deadline: null,
  },
  {
    id: 'issue-002',
    type: 'UNBUNDLING',
    severity: 'MEDIUM' as const,
    cpt_codes: ['99000'],
    title: 'Specimen handling billed separately',
    description: 'CPT 99000 (specimen handling) is included in the global fee for CPT 36415 (venipuncture) and should not be billed separately per CMS bundling rules.',
    amount_at_risk: 75.00,
    action_required: 'Request removal of CPT 99000 charge of $75.00.',
    deadline: null,
  },
  {
    id: 'issue-003',
    type: 'UPCODING',
    severity: 'HIGH' as const,
    cpt_codes: ['99285'],
    title: 'Possible upcoding of ED visit level',
    description: 'CPT 99285 (highest complexity ED visit) was billed for a visit documented as moderate complexity. This level requires high-complexity medical decision-making.',
    amount_at_risk: 175.00,
    action_required: 'Request documentation review and rebilling at appropriate complexity level.',
    deadline: null,
  },
]

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_ROLE_KEY },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Sign-in failed: ${JSON.stringify(data)}`)
  return data.access_token
}

async function setup() {
  // Create test user
  const { data, error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`Failed to create user: ${error?.message}`)
  userId = data.user.id

  // Insert test document (use service role to bypass RLS)
  const { data: doc, error: docErr } = await admin
    .from('documents')
    .insert({
      user_id: userId,
      type: 'medical_bill',
      file_path: `${userId}/uploads/test-bill.pdf`,
      file_name: 'test-bill.pdf',
      status: 'analyzed',
    })
    .select('id')
    .single()
  if (docErr || !doc) throw new Error(`Failed to insert document: ${docErr?.message}`)
  documentId = doc.id

  // Insert test analysis
  const { data: analysis, error: analysisErr } = await admin
    .from('analyses')
    .insert({
      document_id: documentId,
      extracted_data: EXTRACTED_DATA,
      issues: TEST_ISSUES,
      summary: 'Three billing issues were found totaling $850 in potential overcharges. The most significant is a duplicate chest X-ray charge. You should dispute these charges in writing.',
    })
    .select('id')
    .single()
  if (analysisErr || !analysis) throw new Error(`Failed to insert analysis: ${analysisErr?.message}`)
  analysisId = analysis.id

  console.log(`INFO: Setup complete — user ${userId}, doc ${documentId}, analysis ${analysisId}`)
}

async function cleanup() {
  if (letterId) await admin.from('letters').delete().eq('id', letterId)
  if (analysisId) await admin.from('analyses').delete().eq('id', analysisId)
  if (documentId) await admin.from('documents').delete().eq('id', documentId)
  if (userId) await admin.auth.admin.deleteUser(userId)
  console.log('INFO: Cleanup complete')
}

async function run() {
  try {
    await setup()
  } catch (err) {
    fail(`Setup failed: ${err}`)
    process.exit(1)
  }

  let accessToken: string
  try {
    accessToken = await getAccessToken()
  } catch (err) {
    fail(`Sign-in failed: ${err}`)
    await cleanup()
    process.exit(1)
  }

  try {
    // --- First call: generate letter ---
    console.log('INFO: Calling /api/generate-letter (may take 10–20 seconds)...')
    const res = await fetch(`${BASE_URL}/api/generate-letter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ analysis_id: analysisId }),
    })

    const data = await res.json()

    if (data.success === true) {
      pass('POST /api/generate-letter returned success: true')
    } else {
      fail(`POST /api/generate-letter did not return success: true — ${JSON.stringify(data)}`)
    }

    if (data.letter_id && isUUID(data.letter_id)) {
      pass(`letter_id is a valid UUID: ${data.letter_id}`)
      letterId = data.letter_id
    } else {
      fail(`letter_id missing or invalid: ${data.letter_id}`)
      return
    }

    if (data.cached === false) {
      pass('First call: cached is false (new letter generated)')
    } else {
      fail(`First call: expected cached=false, got cached=${data.cached}`)
    }

    // --- Verify letter in DB ---
    const { data: letterRow, error: letterErr } = await admin
      .from('letters')
      .select('id, content, recipient')
      .eq('id', letterId)
      .single()

    if (letterErr || !letterRow) {
      fail(`Letter row not found in DB: ${letterErr?.message}`)
    } else {
      if (typeof letterRow.content === 'string' && letterRow.content.length > 200) {
        pass(`letter.content is a non-empty string over 200 characters (${letterRow.content.length} chars)`)
      } else {
        fail(`letter.content too short or invalid: ${String(letterRow.content).slice(0, 100)}`)
      }

      if (letterRow.content.includes(TEST_PATIENT_NAME)) {
        pass(`letter.content contains patient name "${TEST_PATIENT_NAME}"`)
      } else {
        fail(`letter.content does not contain patient name "${TEST_PATIENT_NAME}"`)
      }

      if (letterRow.recipient === 'hospital' || letterRow.recipient === 'insurer') {
        pass(`letter.recipient is valid: "${letterRow.recipient}"`)
      } else {
        fail(`letter.recipient is invalid: "${letterRow.recipient}"`)
      }
    }

    // --- Second call: cache check ---
    console.log('INFO: Calling /api/generate-letter again to test caching...')
    const res2 = await fetch(`${BASE_URL}/api/generate-letter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ analysis_id: analysisId }),
    })

    const data2 = await res2.json()

    if (data2.cached === true) {
      pass('Second call: cached is true (existing letter returned)')
    } else {
      fail(`Second call: expected cached=true, got cached=${data2.cached}`)
    }

    if (data2.letter_id === letterId) {
      pass('Second call: same letter_id returned')
    } else {
      fail(`Second call: different letter_id returned (${data2.letter_id} vs ${letterId})`)
    }

    // Confirm no duplicate letter created
    const { count } = await admin
      .from('letters')
      .select('id', { count: 'exact' })
      .eq('analysis_id', analysisId as string)
    if (count === 1) {
      pass('No duplicate letter created in DB')
    } else {
      fail(`Expected 1 letter in DB, found ${count}`)
    }

  } finally {
    await cleanup()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
