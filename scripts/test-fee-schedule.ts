import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

let passed = 0
let failed = 0
function pass(msg: string) { console.log(`PASS: ${msg}`); passed++ }
function fail(msg: string) { console.log(`FAIL: ${msg}`); failed++ }

async function run() {
  // Test 1: fee_schedule row count
  const { count: fsCount } = await supabase
    .from('fee_schedule')
    .select('*', { count: 'exact', head: true })
  if (fsCount && fsCount > 10000) {
    pass(`fee_schedule has ${fsCount} rows`)
  } else {
    fail(`fee_schedule has ${fsCount} rows (expected >10000)`)
  }

  // Test 2: CPT 99285 exists with correct values
  const { data: ed } = await supabase
    .from('fee_schedule')
    .select('*')
    .eq('hcpcs_code', '99285')
    .eq('modifier', '')
    .single()
  if (ed && ed.fac_total > 0) {
    pass(`CPT 99285: fac_total=${ed.fac_total}, conv_factor=${ed.conv_factor}`)
  } else {
    fail(`CPT 99285 not found or has zero facility total`)
  }

  // Test 3: CPT 71046 (chest X-ray) exists
  const { data: xray } = await supabase
    .from('fee_schedule')
    .select('*')
    .eq('hcpcs_code', '71046')
    .eq('modifier', '')
    .single()
  if (xray && xray.fac_total > 0) {
    pass(`CPT 71046: fac_total=${xray.fac_total}`)
  } else {
    fail(`CPT 71046 not found or has zero facility total`)
  }

  // Test 4: gpci row count
  const { count: gpciCount } = await supabase
    .from('gpci')
    .select('*', { count: 'exact', head: true })
  if (gpciCount && gpciCount > 100) {
    pass(`gpci has ${gpciCount} rows`)
  } else {
    fail(`gpci has ${gpciCount} rows (expected >100)`)
  }

  // Test 5: Houston Texas GPCI exists
  const { data: txGpci } = await supabase
    .from('gpci')
    .select('*')
    .eq('state', 'TX')
    .eq('locality_number', '18')
    .single()
  if (txGpci && txGpci.work_gpci > 0) {
    pass(`Houston TX GPCI: work=${txGpci.work_gpci}, pe=${txGpci.pe_gpci}, mp=${txGpci.mp_gpci}`)
  } else {
    fail(`Houston TX GPCI not found`)
  }

  // Test 6: locality_county has data
  const { count: lcCount } = await supabase
    .from('locality_county')
    .select('*', { count: 'exact', head: true })
  if (lcCount && lcCount > 50) {
    pass(`locality_county has ${lcCount} rows`)
  } else {
    fail(`locality_county has ${lcCount} rows (expected >50)`)
  }

  // Test 7: lookupMedicareRate for known case
  // CPT 99285 in Houston TX
  // From the data: work_rvu=4.00, fac_pe_rvu=0.65, mp_rvu=0.48
  // Houston GPCIs: work=1.008, pe=0.993, mp=1.376, conv_factor=33.4009
  // Expected = [(4.00*1.008) + (0.65*0.993) + (0.48*1.376)] * 33.4009
  //          = [4.032 + 0.645 + 0.661] * 33.4009
  //          = 5.338 * 33.4009 ≈ $178.29
  const { lookupMedicareRate } = await import('../src/lib/fee-schedule')
  const rate = await lookupMedicareRate(
    '99285',
    '1234 Medical Center Dr, Houston, TX 77001'
  )
  if (rate.found && rate.facility_amount > 150 && rate.facility_amount < 220) {
    pass(`lookupMedicareRate 99285 Houston: $${rate.facility_amount.toFixed(2)} (expected ~$178)`)
  } else {
    fail(`lookupMedicareRate 99285 Houston: found=${rate.found}, amount=$${rate.facility_amount}`)
  }

  // Test 8: unknown CPT code returns found: false
  const unknown = await lookupMedicareRate('XXXXX', '123 Main St, Austin, TX 78701')
  if (!unknown.found) {
    pass('Unknown CPT code returns found: false')
  } else {
    fail('Unknown CPT code should return found: false')
  }

  // Test 9: statewide locality fallback works
  // Alabama is a single statewide locality
  const alRate = await lookupMedicareRate('99213', '456 Hospital Rd, Birmingham, AL 35201')
  if (alRate.found && alRate.facility_amount > 0) {
    pass(`Statewide locality fallback works: AL 99213 = $${alRate.facility_amount.toFixed(2)}`)
  } else {
    fail(`Statewide locality fallback failed for Alabama`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
