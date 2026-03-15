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
  // Only structural errors count toward the recoverable figure.
  // EXCESSIVE_FACILITY_FEE issues are benchmark context, not guaranteed recovery.
  const STRUCTURAL_TYPES = new Set([
    'DUPLICATE_CHARGE',
    'UPCODING',
    'UNBUNDLING',
    'BUNDLING_VIOLATION',
    'CODING_MISMATCH',
    'APPEALABLE_DENIAL',
    'OTHER',
  ])
  const totalRecoverable = issues
    .filter((issue) => STRUCTURAL_TYPES.has(issue.type))
    .reduce((sum, issue) => sum + issue.amount_at_risk, 0)

  const uniqueIssues = Array.from(
    new Map(issues.map(issue => [issue.id, issue])).values()
  )

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
              {totalRecoverable > 0
                ? `$${totalRecoverable.toLocaleString()} in billing errors`
                : 'No structural errors found'}
            </span>
          </div>
          <p className="text-gray-600">{analysis.summary}</p>
        </div>

        {/* Issues */}
        <div>
          <h2 className="text-gray-900 font-semibold text-lg mb-3">
            Issues found ({uniqueIssues.length})
          </h2>
          <div className="space-y-3">
            {uniqueIssues.map((issue, index) => (
              <IssueCard key={`${issue.id}-${index}`} issue={issue} />
            ))}
            {uniqueIssues.length === 0 && (
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
