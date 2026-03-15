import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !serviceRoleKey) {
  console.error('FAIL: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const BASE_URL = 'http://localhost:3000'
const TEST_EMAIL = `test-integration-${Date.now()}@example.com`
const TEST_PASSWORD = 'testpassword123!'

let passed = 0
let failed = 0
let userId: string | null = null

function pass(msg: string) { console.log(`PASS: ${msg}`); passed++ }
function fail(msg: string) { console.log(`FAIL: ${msg}`); failed++ }

async function cleanup() {
  if (!userId) return
  try {
    // Delete all documents and analyses for this user (cascade handles analyses)
    const { data: docs } = await supabase
      .from('documents')
      .select('id')
      .eq('user_id', userId)
    if (docs && docs.length > 0) {
      const docIds = docs.map((d) => d.id)
      await supabase.from('analyses').delete().in('document_id', docIds)
      await supabase.from('documents').delete().eq('user_id', userId)
    }
    await supabase.auth.admin.deleteUser(userId)
    console.log(`INFO: Cleaned up test user ${userId}`)
  } catch (err) {
    console.log(`WARN: Cleanup error: ${err}`)
  }
}

async function run() {
  // Create test user
  const { data: createData, error: createError } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  })

  if (createError || !createData.user) {
    fail(`Could not create test user: ${createError?.message}`)
    process.exit(1)
  }

  userId = createData.user.id
  console.log(`INFO: Created test user ${userId}`)

  // Insert public.users row (documents table FK requires it)
  const { error: userInsertError } = await supabase
    .from('users')
    .insert({ id: userId, full_name: 'Integration Test User' })
  if (userInsertError) {
    console.log(`WARN: Could not insert public.users row: ${userInsertError.message}`)
  }

  // Sign in to get Bearer token
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  })

  if (signInError || !signInData.session) {
    fail(`Could not sign in: ${signInError?.message}`)
    await cleanup()
    process.exit(1)
  }

  const token = signInData.session.access_token
  console.log('INFO: Signed in, got Bearer token')

  // ── Test 2: POST without provider fields → expect 400 ──────────────────────
  const billPath = path.resolve(process.cwd(), 'scripts/test_bills/bill_1_er_visit.pdf')
  if (!fs.existsSync(billPath)) {
    fail(`Test bill not found: ${billPath}`)
    await cleanup()
    process.exit(1)
  }

  const billBytes = fs.readFileSync(billPath)
  const blob = new Blob([billBytes], { type: 'application/pdf' })

  const fd1 = new FormData()
  fd1.append('file', blob, 'bill_1_er_visit.pdf')
  // Intentionally omit provider_state and provider_county

  const res1 = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd1,
  })

  if (res1.status === 400) {
    pass(`Validation rejects missing location fields: status=${res1.status} (expected 400)`)
  } else {
    fail(`Validation did not reject missing location fields: status=${res1.status} (expected 400)`)
  }

  // ── Test 3: Full analysis with location data ────────────────────────────────
  const billBytes2 = fs.readFileSync(billPath)
  const blob2 = new Blob([billBytes2], { type: 'application/pdf' })

  const fd2 = new FormData()
  fd2.append('file', blob2, 'bill_1_er_visit.pdf')
  fd2.append('provider_state', 'TX')
  fd2.append('provider_county', 'HARRIS')

  console.log('INFO: Submitting bill for full analysis (this may take 20-40s)...')
  const res2 = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd2,
  })

  const data2 = await res2.json()

  if (!res2.ok || !data2.success) {
    fail(`Full analysis failed: status=${res2.status}, error=${data2.error ?? JSON.stringify(data2)}`)
    await cleanup()
    process.exit(1)
  }

  pass(`Full analysis succeeded: success=true (expected true)`)

  const analysis = data2.analysis

  // Assert provider_state
  if (analysis.provider_state === 'TX') {
    pass(`analysis.provider_state = "${analysis.provider_state}" (expected "TX")`)
  } else {
    fail(`analysis.provider_state = "${analysis.provider_state}" (expected "TX")`)
  }

  // Assert provider_county
  if (analysis.provider_county === 'HARRIS') {
    pass(`analysis.provider_county = "${analysis.provider_county}" (expected "HARRIS")`)
  } else {
    fail(`analysis.provider_county = "${analysis.provider_county}" (expected "HARRIS")`)
  }

  // Assert line_items is array with at least one item
  if (Array.isArray(analysis.line_items) && analysis.line_items.length > 0) {
    pass(`analysis.line_items is array with ${analysis.line_items.length} items (expected ≥1)`)
  } else {
    fail(`analysis.line_items = ${JSON.stringify(analysis.line_items)} (expected non-empty array)`)
  }

  // Assert at least one line item has non-null medicare_facility_amount
  const withMedicare = (analysis.line_items as Array<{ medicare_facility_amount: number | null }>)
    .filter((li) => li.medicare_facility_amount !== null)
  if (withMedicare.length > 0) {
    pass(`${withMedicare.length} line item(s) have non-null medicare_facility_amount (expected ≥1)`)
  } else {
    fail(`No line items have medicare_facility_amount (expected ≥1 to be non-null)`)
  }

  // Assert at least one line item has non-null price_ratio
  const withRatio = (analysis.line_items as Array<{ price_ratio: number | null }>)
    .filter((li) => li.price_ratio !== null)
  if (withRatio.length > 0) {
    pass(`${withRatio.length} line item(s) have non-null price_ratio (expected ≥1)`)
  } else {
    fail(`No line items have price_ratio (expected ≥1 to be non-null)`)
  }

  // Assert issues is array
  if (Array.isArray(analysis.issues)) {
    pass(`analysis.issues is an array with ${analysis.issues.length} items`)
  } else {
    fail(`analysis.issues is not an array: ${JSON.stringify(analysis.issues)}`)
  }

  await cleanup()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch(async (err) => {
  console.error('Unexpected error:', err)
  await cleanup()
  process.exit(1)
})
