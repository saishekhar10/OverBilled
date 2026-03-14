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
