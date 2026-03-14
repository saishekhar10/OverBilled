# Spec 7: Fee Schedule Data Layer

## Overview
Loads the CMS Medicare Physician Fee Schedule (RVU26B) into Supabase and
exposes a TypeScript lookup function that returns the Medicare allowed amount
for any CPT code and provider location. This is the data foundation that all
future pricing analysis depends on.

This spec covers:
1. Three new Supabase tables: `fee_schedule`, `gpci`, `locality_county`
2. A one-time seed script that parses and loads the CMS data files
3. A `lookupMedicareRate()` TypeScript function in `src/lib/`
4. Automated tests verifying the data loaded correctly and the lookup works

---

## Source Data Files

These files must be placed in `scripts/data/` before running the seed script.
Copy them from the RVU26B zip you downloaded:

| File | Description |
|------|-------------|
| `PPRRVU2026_Apr_nonQPP.csv` | CPT codes, RVUs, conversion factor. 13,068 data rows. Header rows 1-9 are metadata, row 10 is the real column header. Use the nonQPP version — this applies to standard hospital billing. |
| `GPCI2026.txt` | Geographic Practice Cost Indices by locality. Tab-separated. 3 header rows, data starts row 4. 111 locality rows. |
| `26LOCCO.txt` | County-to-locality crosswalk. Tab-separated. 3 header rows, data starts row 4. Maps counties to locality numbers. |

---

## Files to Create
- `supabase/migrations/fee_schedule_tables.sql`
- `scripts/seed-fee-schedule.ts`
- `src/lib/fee-schedule.ts`
- `scripts/test-fee-schedule.ts`

---

## 1. Database Migration

### File: `supabase/migrations/fee_schedule_tables.sql`

```sql
-- Fee schedule: one row per CPT code (and modifier combination)
create table if not exists fee_schedule (
  id             serial primary key,
  hcpcs_code     text not null,
  modifier       text not null default '',
  description    text,
  status_code    text,
  work_rvu       numeric(8,2),
  non_fac_pe_rvu numeric(8,2),
  fac_pe_rvu     numeric(8,2),
  mp_rvu         numeric(6,4),
  non_fac_total  numeric(8,2),
  fac_total      numeric(8,2),
  conv_factor    numeric(10,4),
  created_at     timestamp default now()
);

create unique index if not exists fee_schedule_code_mod_idx
  on fee_schedule (hcpcs_code, modifier);

create index if not exists fee_schedule_hcpcs_idx
  on fee_schedule (hcpcs_code);

-- Geographic Practice Cost Indices: one row per locality
create table if not exists gpci (
  id              serial primary key,
  mac             text,
  state           text not null,
  locality_number text not null,
  locality_name   text,
  work_gpci       numeric(6,3),
  pe_gpci         numeric(6,3),
  mp_gpci         numeric(6,3),
  created_at      timestamp default now()
);

create unique index if not exists gpci_state_locality_idx
  on gpci (state, locality_number);

create index if not exists gpci_state_idx
  on gpci (state);

-- Locality/county crosswalk: maps state + county to locality number
create table if not exists locality_county (
  id              serial primary key,
  mac             text,
  locality_number text not null,
  state           text not null,
  locality_name   text,
  counties        text,
  is_statewide    boolean default false,
  created_at      timestamp default now()
);

create index if not exists locality_county_state_idx
  on locality_county (state);

create index if not exists locality_county_state_locality_idx
  on locality_county (state, locality_number);
```

### Notes on schema design
- `fee_schedule` uses a unique index on `(hcpcs_code, modifier)` because some
  CPT codes appear multiple times with different modifiers. For example 71046
  appears three times: no modifier = global service, modifier 26 = professional
  component only, modifier TC = technical component only. For billing analysis
  we primarily want the row with no modifier (the global service).
- `gpci.work_gpci` stores the "with 1.0 floor" value (column 6 in the source
  file), not the "without floor" value (column 5). This is the value used for
  actual payment calculations per CMS documentation.
- `locality_county.counties` stores the raw counties string as-is from the
  source file. Parsing individual county names from it happens in the lookup
  function at query time using ILIKE, not at load time.

---

## 2. Seed Script

### File: `scripts/seed-fee-schedule.ts`

This script runs once to load all three data files into Supabase. It must be
idempotent — running it twice should not create duplicate rows (use upsert).

### Install dependency first
```bash
npm install csv-parse --save-dev
```

### Full script

```typescript
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

const DATA_DIR = path.resolve(process.cwd(), 'scripts/data')
const BATCH_SIZE = 500

async function seedFeeSchedule() {
  console.log('Loading fee schedule...')
  const raw = fs.readFileSync(
    path.join(DATA_DIR, 'PPRRVU2026_Apr_nonQPP.csv'), 'utf-8'
  )

  // Skip the first 9 rows (metadata) — row 10 is the real column header
  const lines = raw.split('\n')
  const csvContent = lines.slice(9).join('\n')

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[]

  // Log actual column names on first run to verify mapping
  if (records.length > 0) {
    console.log('  Columns detected:', Object.keys(records[0]).join(', '))
  }

  const rows = records
    .filter(r => r['HCPCS']?.trim())
    .map(r => ({
      hcpcs_code:      r['HCPCS'].trim(),
      modifier:        r['MOD']?.trim() ?? '',
      description:     r['DESCRIPTION']?.trim() ?? null,
      status_code:     r['CODE']?.trim() ?? null,
      work_rvu:        parseFloat(r['WORK RVU']) || 0,
      non_fac_pe_rvu:  parseFloat(r['NON-FAC PE RVU']) || 0,
      fac_pe_rvu:      parseFloat(r['FACILITY PE RVU']) || 0,
      mp_rvu:          parseFloat(r['MP RVU']) || 0,
      non_fac_total:   parseFloat(r['NON-FACILITY TOTAL']) || 0,
      fac_total:       parseFloat(r['FACILITY TOTAL']) || 0,
      conv_factor:     parseFloat(r['CONV FACTOR']) || 33.4009,
    }))

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('fee_schedule')
      .upsert(batch, { onConflict: 'hcpcs_code,modifier' })
    if (error) throw new Error(`fee_schedule insert error: ${error.message}`)
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

  const { error } = await supabase
    .from('gpci')
    .upsert(rows, { onConflict: 'state,locality_number' })
  if (error) throw new Error(`gpci insert error: ${error.message}`)
  console.log(`gpci: ${rows.length} rows loaded`)
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
      // Strip trailing spaces and normalize state to 2-letter abbreviation
      state:           lastState.trim().replace(/\s+/g, '').slice(0, 2),
      locality_name:   area ?? '',
      counties:        counties ?? '',
      is_statewide:    isStatewide,
    })
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('locality_county')
      .upsert(batch, { onConflict: 'state,locality_number' })
    if (error) throw new Error(`locality_county insert error: ${error.message}`)
    inserted += batch.length
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
```

### Run command
```bash
# Copy the data files into place first
mkdir -p scripts/data
cp /path/to/PPRRVU2026_Apr_nonQPP.csv scripts/data/
cp /path/to/GPCI2026.txt scripts/data/
cp /path/to/26LOCCO.txt scripts/data/

# Run the seed
npx tsx scripts/seed-fee-schedule.ts
```

---

## 3. Lookup Function

### File: `src/lib/fee-schedule.ts`

Takes a CPT code and a provider address string (as returned by Claude in the
existing bill analysis) and returns the Medicare allowed amount for that
procedure in that geographic location.

### How the lookup works

1. Parse the state abbreviation and county/city from the provider address
   using a lightweight Claude call
2. Find the matching locality in `locality_county` for that state and county
3. Get the GPCI values for that locality from `gpci`
4. Get the RVU values for the CPT code from `fee_schedule`
5. Apply the CMS payment formula and return the result

### Payment formula (from CMS documentation)

```
Facility Payment Amount =
  [(work_rvu × work_gpci) +
   (fac_pe_rvu × pe_gpci) +
   (mp_rvu × mp_gpci)] × conv_factor

Non-Facility Payment Amount =
  [(work_rvu × work_gpci) +
   (non_fac_pe_rvu × pe_gpci) +
   (mp_rvu × mp_gpci)] × conv_factor
```

Hospital bills are almost always facility setting. Return both values but use
`facility_amount` as the primary benchmark for dispute letter generation.

### Locality matching priority
1. First look for a specific locality where the county/city appears in the
   `counties` column for that state (is_statewide = false)
2. Fall back to the statewide locality for that state (is_statewide = true)
3. If neither found, use GPCIs of 1.0 for all three and log a warning

### Full implementation

```typescript
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

export interface MedicareRate {
  cpt_code: string
  description: string | null
  locality_name: string
  state: string
  facility_amount: number
  non_facility_amount: number
  work_rvu: number
  fac_pe_rvu: number
  mp_rvu: number
  work_gpci: number
  pe_gpci: number
  mp_gpci: number
  conv_factor: number
  found: boolean
}

export interface ParsedLocation {
  state: string
  county_or_city: string
}

function getFeeScheduleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function parseProviderLocation(
  address: string
): Promise<ParsedLocation | null> {
  if (!address?.trim()) return null

  // Try simple regex first before making an API call
  const stateZipMatch = address.match(/\b([A-Z]{2})\s*\d{5}/)
  const stateNameMatch = address.match(
    /,\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/
  )

  let stateAbbr: string | null = null
  let cityOrCounty: string | null = null

  if (stateZipMatch) {
    stateAbbr = stateZipMatch[1]
  }
  if (stateNameMatch) {
    cityOrCounty = stateNameMatch[1].trim()
    stateAbbr = stateAbbr ?? stateNameMatch[2]
  }

  // If regex got both pieces we don't need Claude
  if (stateAbbr && cityOrCounty) {
    return { state: stateAbbr, county_or_city: cityOrCounty }
  }

  // Fall back to Claude for unusual address formats
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: 'Extract the US state abbreviation and county or city name from the provider address. Return JSON only, no other text: {"state": "TX", "county_or_city": "Harris County"}. Use 2-letter state abbreviation. If you cannot determine the state return null.',
      messages: [{ role: 'user', content: address }],
    })
    const text = response.content.find(b => b.type === 'text')?.text?.trim()
    if (!text) return null
    const parsed = JSON.parse(text) as ParsedLocation
    if (!parsed.state) return null
    return parsed
  } catch {
    // If Claude fails, return whatever regex found
    if (stateAbbr) {
      return { state: stateAbbr, county_or_city: cityOrCounty ?? '' }
    }
    return null
  }
}

export async function lookupMedicareRate(
  cptCode: string,
  providerAddress: string
): Promise<MedicareRate> {
  const supabase = getFeeScheduleClient()
  const code = cptCode.trim().toUpperCase()

  const defaultRate: MedicareRate = {
    cpt_code: code,
    description: null,
    locality_name: 'Unknown',
    state: '',
    facility_amount: 0,
    non_facility_amount: 0,
    work_rvu: 0,
    fac_pe_rvu: 0,
    mp_rvu: 0,
    work_gpci: 1.0,
    pe_gpci: 1.0,
    mp_gpci: 1.0,
    conv_factor: 33.4009,
    found: false,
  }

  // Step 1: Look up the CPT code (global service — no modifier)
  const { data: fs } = await supabase
    .from('fee_schedule')
    .select('*')
    .eq('hcpcs_code', code)
    .eq('modifier', '')
    .single()

  if (!fs) return defaultRate

  // Step 2: Parse provider location
  const location = await parseProviderLocation(providerAddress)

  // Step 3: Find locality
  let localityNumber: string | null = null
  let localityName = 'National Average'
  let workGpci = 1.0
  let peGpci = 1.0
  let mpGpci = 1.0
  let state = ''

  if (location?.state) {
    state = location.state

    // Try specific locality first
    if (location.county_or_city) {
      const { data: specific } = await supabase
        .from('locality_county')
        .select('locality_number, locality_name')
        .eq('state', state)
        .eq('is_statewide', false)
        .ilike('counties', `%${location.county_or_city}%`)
        .limit(1)
        .single()

      if (specific) {
        localityNumber = specific.locality_number
        localityName = specific.locality_name
      }
    }

    // Fall back to statewide locality
    if (!localityNumber) {
      const { data: statewide } = await supabase
        .from('locality_county')
        .select('locality_number, locality_name')
        .eq('state', state)
        .eq('is_statewide', true)
        .limit(1)
        .single()

      if (statewide) {
        localityNumber = statewide.locality_number
        localityName = statewide.locality_name
      }
    }

    // Get GPCI values for the locality
    if (localityNumber) {
      const { data: gpciRow } = await supabase
        .from('gpci')
        .select('work_gpci, pe_gpci, mp_gpci, locality_name')
        .eq('state', state)
        .eq('locality_number', localityNumber)
        .single()

      if (gpciRow) {
        workGpci = gpciRow.work_gpci
        peGpci = gpciRow.pe_gpci
        mpGpci = gpciRow.mp_gpci
        localityName = gpciRow.locality_name ?? localityName
      }
    }
  }

  // Step 4: Apply payment formula
  const workRvu   = fs.work_rvu ?? 0
  const facPeRvu  = fs.fac_pe_rvu ?? 0
  const nonFacPeRvu = fs.non_fac_pe_rvu ?? 0
  const mpRvu     = fs.mp_rvu ?? 0
  const cf        = fs.conv_factor ?? 33.4009

  const facilityAmount = (
    (workRvu * workGpci) +
    (facPeRvu * peGpci) +
    (mpRvu * mpGpci)
  ) * cf

  const nonFacilityAmount = (
    (workRvu * workGpci) +
    (nonFacPeRvu * peGpci) +
    (mpRvu * mpGpci)
  ) * cf

  return {
    cpt_code:            code,
    description:         fs.description,
    locality_name:       localityName,
    state,
    facility_amount:     Math.round(facilityAmount * 100) / 100,
    non_facility_amount: Math.round(nonFacilityAmount * 100) / 100,
    work_rvu:            workRvu,
    fac_pe_rvu:          facPeRvu,
    mp_rvu:              mpRvu,
    work_gpci:           workGpci,
    pe_gpci:             peGpci,
    mp_gpci:             mpGpci,
    conv_factor:         cf,
    found:               true,
  }
}

export async function lookupMedicareRates(
  cptCodes: string[],
  providerAddress: string
): Promise<MedicareRate[]> {
  // Deduplicate codes, preserve original order
  const unique = [...new Set(cptCodes.map(c => c.trim().toUpperCase()))]

  // Parse location once, reuse for all lookups
  const location = await parseProviderLocation(providerAddress)
  const addressForLookup = location
    ? `${location.county_or_city}, ${location.state}`
    : providerAddress

  const results = await Promise.all(
    unique.map(code => lookupMedicareRate(code, addressForLookup))
  )

  // Map back to original order including duplicates
  const resultMap = new Map(results.map(r => [r.cpt_code, r]))
  return cptCodes.map(code =>
    resultMap.get(code.trim().toUpperCase()) ?? {
      cpt_code: code,
      description: null,
      locality_name: 'Unknown',
      state: '',
      facility_amount: 0,
      non_facility_amount: 0,
      work_rvu: 0,
      fac_pe_rvu: 0,
      mp_rvu: 0,
      work_gpci: 1.0,
      pe_gpci: 1.0,
      mp_gpci: 1.0,
      conv_factor: 33.4009,
      found: false,
    }
  )
}
```

---

## 4. Automated Testing

After implementing all files above, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve errors, and report
results.

### Pre-test check
```bash
ls scripts/data/PPRRVU2026_Apr_nonQPP.csv || echo "MISSING: copy data files to scripts/data/"
ls scripts/data/GPCI2026.txt || echo "MISSING"
ls scripts/data/26LOCCO.txt || echo "MISSING"
```

### Test 1 — TypeScript compilation
```bash
npx tsc --noEmit
# Expected: no errors
```

### Test 2 — Run seed script
```bash
npx tsx scripts/seed-fee-schedule.ts
# Expected: all three tables load without errors
# Expected output:
#   fee_schedule: ~13068 rows loaded
#   gpci: ~111 rows loaded
#   locality_county: rows loaded without error
```

### Test 3 — Verify data and lookup

### File: `scripts/test-fee-schedule.ts`

```typescript
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
```

```bash
npx tsx scripts/test-fee-schedule.ts
```

---

## Error Resolution Rules

1. **`csv-parse` not found** — run `npm install csv-parse --save-dev` then retry

2. **Column name mismatch in fee_schedule seed** — the CSV header is on row 10
   and column names include spaces. If mapping fails, add this debug line after
   parsing: `console.log('Columns:', Object.keys(records[0]))` to see the
   actual names and adjust the mapping

3. **GPCI footer rows causing insert errors** — verify the `/^\d/.test(mac)`
   filter is excluding footer lines. Add `console.log('Skipping:', mac)` to
   confirm

4. **locality_county state values incorrect** — the source file has state names
   with trailing spaces like "ALABAMA " and "TEXAS ". The seed script trims
   and slices to 2 characters. If states are still wrong, log `lastState`
   before the slice to see what the raw value is

5. **lookupMedicareRate returns wrong amount** — log each intermediate value:
   work_rvu, fac_pe_rvu, mp_rvu, work_gpci, pe_gpci, mp_gpci, conv_factor.
   Compare against the manual calculation in Test 7 to find where it diverges

6. **Address parsing returns null for valid addresses** — check the regex
   patterns first. The pattern `\b([A-Z]{2})\s*\d{5}` requires uppercase state
   abbreviation. If Claude's extracted provider address uses mixed case, add
   `.toUpperCase()` before matching

7. **TypeScript errors on csv-parse import** — use
   `import { parse } from 'csv-parse/sync'` not a default import.
   If type errors persist add `// @ts-ignore` above the import as a last resort

8. **Supabase upsert fails with conflict error** — ensure the unique indexes
   were created by the migration SQL before running the seed. Re-run the
   migration if needed.

Report each test as PASS or FAIL. Confirm when all pass and the data layer
is ready for Spec 8.