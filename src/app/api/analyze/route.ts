import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { analyzeDocument, type AnalysisResult } from '@/lib/analyze'

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_PAGE_SIZE = 5 * 1024 * 1024
const MAX_PAGES = 20

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

  // When a Bearer token is present, create a user-context client so that
  // storage and DB operations carry the user's auth (the SSR cookie client
  // only works for browser sessions).
  const authedSupabase = token
    ? createSupabaseClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { autoRefreshToken: false, persistSession: false },
        }
      )
    : supabase

  // Parse multipart form data
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const providerState = (formData.get('provider_state') as string)?.trim().toUpperCase()
  const providerCounty = (formData.get('provider_county') as string)?.trim().toUpperCase()

  if (!providerState || !providerCounty) {
    return NextResponse.json(
      { error: 'provider_state and provider_county are required' },
      { status: 400 }
    )
  }

  // Detect whether this is a multi-page scrubbed upload (pages[]) or a raw file upload
  const pages = formData.getAll('pages') as File[]
  const isMultiPage = pages.length > 0

  let documentId: string | null = null
  const timestamp = Date.now()

  if (isMultiPage) {
    // Multi-page path: client has scrubbed a PDF and sent each page as a JPG
    const pageCountRaw = formData.get('page_count') as string | null
    const declaredPageCount = pageCountRaw ? parseInt(pageCountRaw, 10) : -1
    const originalFilename = (formData.get('original_filename') as string) || 'document.pdf'

    if (pages.length !== declaredPageCount || pages.length === 0) {
      return NextResponse.json({ error: 'Page count mismatch' }, { status: 400 })
    }
    if (pages.length > MAX_PAGES) {
      return NextResponse.json({ error: `Too many pages (max ${MAX_PAGES})` }, { status: 400 })
    }
    for (const page of pages) {
      if (page.type !== 'image/jpeg') {
        return NextResponse.json({ error: 'All pages must be JPEG' }, { status: 400 })
      }
      if (page.size > MAX_PAGE_SIZE) {
        return NextResponse.json({ error: 'A page image exceeds the 5MB size limit' }, { status: 400 })
      }
    }

    // Step 1: Upload each page to Supabase Storage
    const storagePaths: string[] = []
    for (let i = 0; i < pages.length; i++) {
      const pageBuffer = Buffer.from(await pages[i].arrayBuffer())
      const path = `${user.id}/uploads/${timestamp}-page-${i}.jpg`
      const { error: uploadError } = await authedSupabase.storage
        .from('uploads')
        .upload(path, pageBuffer, { contentType: 'image/jpeg', upsert: false })
      if (uploadError) {
        console.error('Storage upload error (page):', uploadError)
        return NextResponse.json({ error: 'Failed to upload page' }, { status: 500 })
      }
      storagePaths.push(path)
    }

    // Step 2: Create document row (one record, file_path points to first page)
    const { data: document, error: insertError } = await authedSupabase
      .from('documents')
      .insert({
        user_id: user.id,
        type: null,
        file_path: storagePaths[0],
        file_name: originalFilename,
        status: 'processing',
      })
      .select('id')
      .single()

    if (insertError || !document) {
      console.error('Document insert error:', insertError)
      return NextResponse.json({ error: 'Failed to create document record' }, { status: 500 })
    }

    documentId = document.id

    // Step 3: Call Claude extraction with all page buffers
    const pageBuffers = await Promise.all(
      pages.map(async (p) => Buffer.from(await p.arrayBuffer()))
    )

    let result: AnalysisResult
    try {
      result = await analyzeDocument(pageBuffers, 'image/jpeg', providerState, providerCounty)
    } catch (err) {
      console.error('Claude analysis error:', err)
      await authedSupabase.from('documents').update({ status: 'error' }).eq('id', documentId)
      return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
    }

    // Step 4: Write analysis to database
    const { issues, summary, ...extractedData } = result

    const { data: analysis, error: analysisError } = await authedSupabase
      .from('analyses')
      .insert({ document_id: documentId, extracted_data: extractedData, issues, summary })
      .select('id')
      .single()

    if (analysisError || !analysis) {
      console.error('Analysis insert error:', analysisError)
      await authedSupabase.from('documents').update({ status: 'error' }).eq('id', documentId)
      return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 })
    }

    await authedSupabase
      .from('documents')
      .update({ type: result.document_type, status: 'analyzed' })
      .eq('id', documentId)

    return NextResponse.json({
      success: true,
      document_id: documentId,
      analysis_id: analysis.id,
      analysis: result,
    })
  }

  // -------------------------------------------------------------------------
  // Single-file path (images or direct API uploads)
  // -------------------------------------------------------------------------

  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds 10MB limit' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // Step 1: Upload file to Supabase Storage
  const storagePath = `${user.id}/uploads/${timestamp}-${file.name}`

  const { error: uploadError } = await authedSupabase.storage
    .from('uploads')
    .upload(storagePath, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('Storage upload error:', uploadError)
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 })
  }

  // Step 2: Create document row
  const { data: document, error: insertError } = await authedSupabase
    .from('documents')
    .insert({
      user_id: user.id,
      type: null,
      file_path: storagePath,
      file_name: file.name,
      status: 'processing',
    })
    .select('id')
    .single()

  if (insertError || !document) {
    console.error('Document insert error:', insertError)
    return NextResponse.json({ error: 'Failed to create document record' }, { status: 500 })
  }

  documentId = document.id

  // Step 3: Call Claude extraction
  let result: AnalysisResult
  try {
    result = await analyzeDocument(buffer, file.type, providerState, providerCounty)
  } catch (err) {
    console.error('Claude analysis error:', err)
    await authedSupabase.from('documents').update({ status: 'error' }).eq('id', documentId)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }

  // Step 4: Write analysis to database
  const { issues, summary, ...extractedData } = result

  const { data: analysis, error: analysisError } = await authedSupabase
    .from('analyses')
    .insert({
      document_id: documentId,
      extracted_data: extractedData,
      issues,
      summary,
    })
    .select('id')
    .single()

  if (analysisError || !analysis) {
    console.error('Analysis insert error:', analysisError)
    await authedSupabase.from('documents').update({ status: 'error' }).eq('id', documentId)
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 })
  }

  // Step 5: Update document status and type
  const { error: updateError } = await authedSupabase
    .from('documents')
    .update({ type: result.document_type, status: 'analyzed' })
    .eq('id', documentId)

  if (updateError) {
    console.error('Document update error:', updateError)
    await authedSupabase.from('documents').update({ status: 'error' }).eq('id', documentId)
    return NextResponse.json({ error: 'Failed to update document status' }, { status: 500 })
  }

  // Step 6: Return success response
  return NextResponse.json({
    success: true,
    document_id: documentId,
    analysis_id: analysis.id,
    analysis: result,
  })
}
