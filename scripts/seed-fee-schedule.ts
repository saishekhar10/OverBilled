import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse/sync'
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const DATA_DIR = path.resolve(process.cwd(), 'scripts/fee-schedule-data')
const BATCH_SIZE = 200

async function upsertWithRetry(
  table: string,
  batch: object[],
  onConflict: string,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict })
    if (!error) return
    if (attempt < maxRetries) {
      process.stdout.write(`\n  Network error, retrying (${attempt}/${maxRetries})...`)
      await new Promise(r => setTimeout(r, 1000 * attempt))
    } else {
      throw new Error(`${table} insert error: ${error.message}`)
    }
  }
}

async function seedFeeSchedule() {
  console.log('Loading fee schedule...')
  const raw = fs.readFileSync(
    path.join(DATA_DIR, 'PPRRVU2026_Apr_nonQPP.csv'), 'utf-8'
  )

  // Skip the first 9 rows (metadata) — row 10 is the real column header, data starts row 11
  // The header row has duplicate column names (RVU, PE RVU, TOTAL, etc.) so we parse by index:
  // Col 0: HCPCS, 1: MOD, 2: DESCRIPTION, 3: STATUS CODE, 5: WORK RVU
  // Col 6: NON-FAC PE RVU, 8: FACILITY PE RVU, 10: MP RVU
  // Col 11: NON-FACILITY TOTAL, 12: FACILITY TOTAL, 25: CONV FACTOR
  const lines = raw.split('\n')
  const csvContent = lines.slice(9).join('\n')

  const records = parse(csvContent, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    from_line: 2, // skip the header row (row 10 of original file)
  }) as string[][]

  console.log(`  Parsed ${records.length} data rows`)

  const rows = records
    .filter(r => r[0]?.trim())
    .map(r => ({
      hcpcs_code:      r[0].trim(),
      modifier:        r[1]?.trim() ?? '',
      description:     r[2]?.trim() || null,
      status_code:     r[3]?.trim() || null,
      work_rvu:        parseFloat(r[5]) || 0,
      non_fac_pe_rvu:  parseFloat(r[6]) || 0,
      fac_pe_rvu:      parseFloat(r[8]) || 0,
      mp_rvu:          parseFloat(r[10]) || 0,
      non_fac_total:   parseFloat(r[11]) || 0,
      fac_total:       parseFloat(r[12]) || 0,
      conv_factor:     parseFloat(r[25]) || 33.4009,
    }))

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await upsertWithRetry('fee_schedule', batch, 'hcpcs_code,modifier')
    inserted += batch.length
    process.stdout.write(`\r  fee_schedule: ${inserted}/${rows.length}`)
  }
  console.log(`\nfee_schedule: ${rows.length} rows loaded`)
}

async function seedGpci() {
  console.log('Loading GPCI...')
  const raw = fs.readFileSync(
    path.join(DATA_DIR, 'GPCI2026.txt'), 'utf-8'
  )

  // Skip title row and blank row — row 3 is the header
  const lines = raw.split('\n').slice(2)
  const tsvContent = lines.join('\n')

  const records = parse(tsvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: '\t',
    relax_column_count: true,
  }) as Record<string, string>[]

  const rows = records
    .filter(r => {
      const mac = r['Medicare Administrative Contractor (MAC)']?.trim()
      // Skip footer notes — they start with quotes or asterisks not digits
      return mac && /^\d/.test(mac)
    })
    .map(r => ({
      mac:             r['Medicare Administrative Contractor (MAC)'].trim(),
      state:           r['State'].trim(),
      locality_number: r['Locality Number'].trim(),
      locality_name:   r['Locality Name'].trim(),
      // Use "with 1.0 Floor" for work GPCI — this is the payment calculation value
      work_gpci:       parseFloat(r['2026 PW GPCI (with 1.0 Floor)']) || 1.0,
      pe_gpci:         parseFloat(r['2026 PE GPCI']) || 1.0,
      mp_gpci:         parseFloat(r['2026 MP GPCI']) || 1.0,
    }))

  await upsertWithRetry('gpci', rows, 'state,locality_number')
  console.log(`gpci: ${rows.length} rows loaded`)
}

// Full state name → 2-letter abbreviation mapping
// The LOCCO file stores full state names (e.g. "TEXAS ") not abbreviations.
// Taking .slice(0,2) of the name produces wrong codes (e.g. "TE" for Texas).
const STATE_NAME_TO_ABBR: Record<string, string> = {
  'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR',
  'CALIFORNIA': 'CA', 'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE',
  'DISTRICT OF COLUMBIA': 'DC', 'FLORIDA': 'FL', 'GEORGIA': 'GA',
  'HAWAII': 'HI', 'HAWAII/GUAM': 'HI', 'IDAHO': 'ID', 'ILLINOIS': 'IL',
  'INDIANA': 'IN', 'IOWA': 'IA', 'KANSAS': 'KS', 'KENTUCKY': 'KY',
  'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD', 'MASSACHUSETTS': 'MA',
  'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS', 'MISSOURI': 'MO',
  'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH',
  'OKLAHOMA': 'OK', 'OREGON': 'OR', 'PENNSYLVANIA': 'PA',
  'PUERTO RICO': 'PR', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT',
  'VERMONT': 'VT', 'VIRGIN ISLANDS': 'VI', 'VIRGINIA': 'VA',
  'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV', 'WISCONSIN': 'WI',
  'WYOMING': 'WY',
}

function toStateAbbr(name: string): string {
  const key = name.trim().toUpperCase()
  return STATE_NAME_TO_ABBR[key] ?? key.replace(/\s+/g, '').slice(0, 2)
}

async function seedLocalityCounty() {
  console.log('Loading locality/county crosswalk...')
  const raw = fs.readFileSync(
    path.join(DATA_DIR, '26LOCCO.txt'), 'utf-8'
  )

  const lines = raw.split('\n').slice(2)
  const tsvContent = lines.join('\n')

  const records = parse(tsvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: '\t',
    relax_column_count: true,
  }) as Record<string, string>[]

  const rows: object[] = []
  let lastMac = ''
  let lastLocality = ''
  let lastState = ''

  for (const r of records) {
    // Note: source file has a typo — "Adminstrative" not "Administrative"
    const mac      = r['Medicare Adminstrative Contractor']?.trim()
    const locality = r['Locality Number']?.trim()
    const state    = r['State']?.trim()
    const area     = r['Fee Schedule Area']?.trim()
    const counties = r['Counties']?.trim()

    if (!area && !counties) continue
    if (area?.startsWith('*')) continue

    // Carry forward values for merged-cell rows
    if (mac) lastMac = mac
    if (locality) lastLocality = locality
    if (state) lastState = state

    if (!lastState || !lastLocality) continue

    const countiesUpper = counties?.toUpperCase() ?? ''
    const isStatewide = countiesUpper.includes('ALL COUNTIES') ||
                        countiesUpper.includes('STATEWIDE')

    rows.push({
      mac:             lastMac,
      locality_number: lastLocality,
      state:           toStateAbbr(lastState),
      locality_name:   area ?? '',
      counties:        counties ?? '',
      is_statewide:    isStatewide,
    })
  }

  // Delete all rows first (idempotent — no unique constraint needed)
  const { error: delError } = await supabase
    .from('locality_county')
    .delete()
    .neq('id', 0)
  if (delError) throw new Error(`locality_county delete error: ${delError.message}`)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from('locality_county').insert(batch)
    if (error) throw new Error(`locality_county insert error: ${error.message}`)
  }
  console.log(`locality_county: ${rows.length} rows loaded`)
}

async function main() {
  try {
    await seedFeeSchedule()
    await seedGpci()
    await seedLocalityCounty()
    console.log('\nAll fee schedule data loaded successfully.')
  } catch (err) {
    console.error('Seed failed:', err)
    process.exit(1)
  }
}

main()
