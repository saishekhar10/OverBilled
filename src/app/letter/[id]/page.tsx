import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import CopyLetterButton from '@/components/CopyLetterButton'
import DownloadPdfButton from '@/components/DownloadPdfButton'

interface LetterPageProps {
  params: Promise<{ id: string }>
}

const recipientLabel: Record<string, string> = {
  hospital: 'Hospital',
  insurer: 'Insurer',
}

export default async function LetterPage({ params }: LetterPageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: letter } = await supabase
    .from('letters')
    .select('*, documents(*), analyses(*)')
    .eq('id', id)
    .single()

  if (!letter) redirect('/dashboard')

  const analysisId = letter.analysis_id as string | null

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="w-full max-w-2xl mx-auto space-y-6">
        {/* Back link */}
        {analysisId ? (
          <Link
            href={`/analysis/${analysisId}`}
            className="text-gray-500 hover:text-gray-700 text-sm flex items-center gap-1"
          >
            ← Back to analysis
          </Link>
        ) : (
          <Link href="/dashboard" className="text-gray-500 hover:text-gray-700 text-sm flex items-center gap-1">
            ← Back to dashboard
          </Link>
        )}

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Your dispute letter</h1>
          {letter.recipient && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-700">
              {recipientLabel[letter.recipient] ?? letter.recipient}
            </span>
          )}
        </div>

        {/* Letter content */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 leading-relaxed">
            {letter.content}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <CopyLetterButton content={letter.content} />
          <DownloadPdfButton />
        </div>
      </div>
    </div>
  )
}
