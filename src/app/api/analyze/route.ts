import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeDocument, type AnalysisResult } from '@/lib/analyze'

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_FILE_SIZE = 10 * 1024 * 1024

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

  // Parse multipart form data
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

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
  let documentId: string | null = null

  // Step 1: Upload file to Supabase Storage
  const timestamp = Date.now()
  const storagePath = `${user.id}/uploads/${timestamp}-${file.name}`

  const { error: uploadError } = await supabase.storage
    .from('uploads')
    .upload(storagePath, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('Storage upload error:', uploadError)
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 })
  }

  // Step 2: Create document row
  const { data: document, error: insertError } = await supabase
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
    result = await analyzeDocument(buffer, file.type)
  } catch (err) {
    console.error('Claude analysis error:', err)
    await supabase.from('documents').update({ status: 'error' }).eq('id', documentId)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }

  // Step 4: Write analysis to database
  const { issues, summary, ...extractedData } = result

  const { data: analysis, error: analysisError } = await supabase
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
    await supabase.from('documents').update({ status: 'error' }).eq('id', documentId)
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 })
  }

  // Step 5: Update document status and type
  const { error: updateError } = await supabase
    .from('documents')
    .update({ type: result.document_type, status: 'analyzed' })
    .eq('id', documentId)

  if (updateError) {
    console.error('Document update error:', updateError)
    await supabase.from('documents').update({ status: 'error' }).eq('id', documentId)
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
