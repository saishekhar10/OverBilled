import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import RiskBadge from '@/components/RiskBadge'
import IssueCard from '@/components/IssueCard'
import GenerateLetterButton from '@/components/GenerateLetterButton'
import { type Issue } from '@/lib/analyze'

interface AnalysisPageProps {
  params: Promise<{ id: string }>
}

export default async function AnalysisPage({ params }: AnalysisPageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: analysis } = await supabase
    .from('analyses')
    .select('*, documents(*)')
    .eq('id', id)
    .single()

  if (!analysis) redirect('/dashboard')

  const issues: Issue[] = Array.isArray(analysis.issues)
    ? analysis.issues
    : typeof analysis.issues === 'string'
    ? JSON.parse(analysis.issues)
    : []

  const extracted = analysis.extracted_data as {
    risk_level?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  } | null

  const riskLevel = (extracted?.risk_level ?? 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  const totalRecoverable = issues.reduce((sum, issue) => sum + issue.amount_at_risk, 0)

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="w-full max-w-2xl mx-auto space-y-6">
        {/* Back link */}
        <Link href="/dashboard" className="text-gray-500 hover:text-gray-700 text-sm flex items-center gap-1">
          ← Back to dashboard
        </Link>

        {/* Header */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-3">
            <RiskBadge level={riskLevel} />
            <span className="text-2xl font-bold text-gray-900">
              ${totalRecoverable.toLocaleString()} recoverable
            </span>
          </div>
          <p className="text-gray-600">{analysis.summary}</p>
        </div>

        {/* Issues */}
        <div>
          <h2 className="text-gray-900 font-semibold text-lg mb-3">
            Issues found ({issues.length})
          </h2>
          <div className="space-y-3">
            {issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
            {issues.length === 0 && (
              <p className="text-gray-500 text-sm">No issues found.</p>
            )}
          </div>
        </div>

        <hr className="border-gray-200" />

        {/* CTA */}
        <GenerateLetterButton analysisId={id} />
      </div>
    </div>
  )
}
