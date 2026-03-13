import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { generateLetter } from '@/lib/generate-letter'
import { type AnalysisResult } from '@/lib/analyze'

export async function POST(request: Request) {
  const supabase = await createClient()

  // Support both Bearer token (API/scripts) and cookie-based session (browser)
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user }, error: authError } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // When using Bearer token, create a client that sends the JWT so RLS resolves auth.uid()
  const queryClient = token
    ? createSupabaseClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { autoRefreshToken: false, persistSession: false },
        }
      )
    : supabase

  // Step 1 — Validate input
  let analysisId: string
  try {
    const body = await request.json()
    analysisId = body.analysis_id
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!analysisId) {
    return NextResponse.json({ error: 'analysis_id is required' }, { status: 400 })
  }

  // Step 2 — Fetch analysis (RLS ensures user owns it)
  const { data: analysis, error: analysisError } = await queryClient
    .from('analyses')
    .select('*, documents(*)')
    .eq('id', analysisId)
    .single()

  if (analysisError || !analysis) {
    return NextResponse.json({ error: 'Analysis not found' }, { status: 404 })
  }

  // Step 3 — Check if letter already exists
  const { data: existing } = await queryClient
    .from('letters')
    .select('id')
    .eq('analysis_id', analysisId)
    .single()

  if (existing) {
    return NextResponse.json({ success: true, letter_id: existing.id, cached: true })
  }

  // Step 4 — Build the analysis payload for Claude
  const documentType = analysis.documents.type as 'medical_bill' | 'denial_letter'
  const payload = {
    document_type: documentType,
    ...analysis.extracted_data,
    issues: analysis.issues,
    summary: analysis.summary,
  } as AnalysisResult

  // Step 5 — Call generateLetter
  let letterContent: string
  try {
    letterContent = await generateLetter(payload, documentType)
  } catch (err) {
    console.error('Letter generation error:', err)
    return NextResponse.json({ error: 'Failed to generate letter' }, { status: 500 })
  }

  // Step 6 — Save letter to database
  const { data: letter, error: insertError } = await queryClient
    .from('letters')
    .insert({
      document_id: analysis.document_id,
      analysis_id: analysisId,
      recipient: documentType === 'denial_letter' ? 'insurer' : 'hospital',
      content: letterContent,
    })
    .select('id')
    .single()

  if (insertError || !letter) {
    console.error('Letter insert error:', insertError)
    return NextResponse.json({ error: 'Failed to save letter' }, { status: 500 })
  }

  // Step 7 — Return success
  return NextResponse.json({ success: true, letter_id: letter.id, cached: false })
}
