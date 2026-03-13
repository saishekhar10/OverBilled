import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import PDFDocument from 'pdfkit'

interface LetterWithDocument {
  id: string
  content: string
  recipient: 'hospital' | 'insurer'
  created_at: string
  documents: {
    type: 'medical_bill' | 'denial_letter'
    file_name: string
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function buildContent(doc: InstanceType<typeof PDFDocument>, letter: LetterWithDocument) {
  // Subtle page header
  doc
    .fontSize(8)
    .fillColor('#999999')
    .text('OverBilled — Patient Dispute Letter', { align: 'left' })
    .moveDown(0.5)
  doc.moveTo(72, doc.y).lineTo(doc.page.width - 72, doc.y).strokeColor('#cccccc').stroke()
  doc.moveDown(1)

  // Letter body — Claude's content already contains date, recipient, body, signature
  doc
    .fillColor('#000000')
    .fontSize(11)
    .font('Helvetica')
    .text(letter.content, {
      align: 'left',
      lineGap: 4,
    })
}

async function buildLetterPdf(letter: LetterWithDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
  })

  const bufferPromise = streamToBuffer(doc)

  buildContent(doc, letter)

  doc.end()
  return bufferPromise
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Auth — Bearer header first, then cookie session
  const authHeader = request.headers.get('Authorization')
  let supabase: ReturnType<typeof createClient>

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return new Response('Unauthorized', { status: 401 })
  } else {
    const cookieStore = await cookies()
    supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cs) { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) },
        },
      }
    )
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return new Response('Unauthorized', { status: 401 })
  }

  // Fetch letter (RLS enforces ownership)
  const { data: letter, error: letterError } = await supabase
    .from('letters')
    .select('*, documents(*)')
    .eq('id', id)
    .single()

  if (letterError || !letter) {
    return new Response('Letter not found', { status: 404 })
  }

  // Generate PDF
  let pdfBuffer: Buffer
  try {
    pdfBuffer = await buildLetterPdf(letter as LetterWithDocument)
  } catch (err) {
    console.error('PDF generation error:', err)
    return new Response('Failed to generate PDF', { status: 500 })
  }

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="dispute-letter-${id.slice(0, 8)}.pdf"`,
    },
  })
}
