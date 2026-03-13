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

const TEST_EMAIL = `test-pdf-${Date.now()}@example.com`
const TEST_PASSWORD = 'testpassword123!'

let passed = 0
let failed = 0
let userId: string | null = null
let documentId: string | null = null
let analysisId: string | null = null
let letterId: string | null = null

function pass(msg: string) { console.log(`PASS: ${msg}`); passed++ }
function fail(msg: string) { console.log(`FAIL: ${msg}`); failed++ }

const LETTER_CONTENT = `March 13, 2026

Billing Department
Metro General Hospital
1234 Medical Center Dr
Austin, TX 78701

Re: Formal Dispute of Charges
Patient: Jane Smith
Account Number: ACC-20240115-001
Date of Service: January 15, 2024

Dear Billing Department,

I am writing to formally dispute several charges on my bill dated February 1, 2024, for services rendered on January 15, 2024. After careful review of the itemized statement, I have identified billing errors totaling $850.00 that require immediate correction.

First, CPT code 71046 (chest X-ray, 2 views) was billed twice on January 15, 2024, with no clinical justification for duplicate imaging. The duplicate charge of $600.00 should be removed from my account entirely, as only one chest X-ray was performed.

Second, CPT code 99000 (specimen handling) was billed separately at $75.00, despite being bundled within the global fee for CPT 36415 (venipuncture) under CMS bundling guidelines. I request that this charge be removed.

Third, CPT code 99285 was billed at the highest complexity level, yet my visit was documented as moderate complexity. I request a review and rebilling at the appropriate level, reducing the charge by $175.00.

The total amount in dispute is $850.00. I request written confirmation of the adjustments within 30 days of receipt of this letter.

Sincerely,
Jane Smith

Phone: ___________________
Email: ___________________
Address: _________________`

async function setup(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`Create user: ${error?.message}`)
  userId = data.user.id

  const { data: doc, error: docErr } = await admin
    .from('documents')
    .insert({ user_id: userId, type: 'medical_bill', file_path: `${userId}/test.pdf`, file_name: 'test-bill.pdf', status: 'analyzed' })
    .select('id').single()
  if (docErr || !doc) throw new Error(`Create document: ${docErr?.message}`)
  documentId = doc.id

  const { data: analysis, error: analysisErr } = await admin
    .from('analyses')
    .insert({
      document_id: documentId,
      extracted_data: { document_type: 'medical_bill', risk_level: 'HIGH', total_recoverable: 850 },
      issues: [{ id: 'i1', type: 'DUPLICATE_CHARGE', severity: 'HIGH', title: 'Duplicate charge', description: 'Test', amount_at_risk: 850, action_required: 'Remove charge', deadline: null, cpt_codes: ['71046'] }],
      summary: 'Test analysis summary.',
    })
    .select('id').single()
  if (analysisErr || !analysis) throw new Error(`Create analysis: ${analysisErr?.message}`)
  analysisId = analysis.id

  const { data: letter, error: letterErr } = await admin
    .from('letters')
    .insert({ document_id: documentId, analysis_id: analysisId, recipient: 'hospital', content: LETTER_CONTENT })
    .select('id').single()
  if (letterErr || !letter) throw new Error(`Create letter: ${letterErr?.message}`)
  letterId = letter.id

  // Sign in to get access token
  const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_ROLE_KEY },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  })
  const session = await signInRes.json()
  if (!session.access_token) throw new Error(`Sign in failed: ${JSON.stringify(session)}`)

  console.log(`INFO: Setup done — user ${userId}, letter ${letterId}`)
  return session.access_token
}

async function cleanup() {
  if (letterId) await admin.from('letters').delete().eq('id', letterId)
  if (analysisId) await admin.from('analyses').delete().eq('id', analysisId)
  if (documentId) await admin.from('documents').delete().eq('id', documentId)
  if (userId) await admin.auth.admin.deleteUser(userId)
  console.log('INFO: Cleanup done')
}

async function run() {
  let accessToken: string
  try {
    accessToken = await setup()
  } catch (err) {
    fail(`Setup failed: ${err}`)
    process.exit(1)
  }

  try {
    // Test 3 — Full PDF generation flow
    const res = await fetch(`${BASE_URL}/api/letter/${letterId}/pdf`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (res.status === 200) {
      pass('Response status is 200')
    } else {
      fail(`Response status is ${res.status} (expected 200)`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/pdf')) {
      pass(`Content-Type is application/pdf`)
    } else {
      fail(`Content-Type is "${contentType}" (expected application/pdf)`)
    }

    const contentDisposition = res.headers.get('content-disposition') ?? ''
    if (contentDisposition.includes('attachment')) {
      pass(`Content-Disposition contains "attachment"`)
    } else {
      fail(`Content-Disposition is "${contentDisposition}" (expected to contain "attachment")`)
    }

    const bodyBuffer = Buffer.from(await res.arrayBuffer())

    if (bodyBuffer.length > 1000) {
      pass(`Response body is ${bodyBuffer.length} bytes (> 1000)`)
    } else {
      fail(`Response body is ${bodyBuffer.length} bytes (expected > 1000)`)
    }

    const magic = bodyBuffer.slice(0, 4).toString('ascii')
    if (magic === '%PDF') {
      pass(`Response body starts with %PDF magic bytes`)
    } else {
      fail(`Response body starts with "${magic}" (expected "%PDF")`)
    }

    // Test 4 — 404 for non-existent letter (authenticated)
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res404 = await fetch(`${BASE_URL}/api/letter/${fakeId}/pdf`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res404.status === 404) {
      pass(`Non-existent letter returns 404`)
    } else {
      fail(`Non-existent letter returned ${res404.status} (expected 404)`)
    }
  } finally {
    await cleanup()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
