'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import UploadZone from '@/components/UploadZone'
import RiskBadge from '@/components/RiskBadge'
import IssueCard from '@/components/IssueCard'
import CopyLetterButton from '@/components/CopyLetterButton'
import DownloadPdfButton from '@/components/DownloadPdfButton'
import type { Issue } from '@/lib/analyze'

type Tab = 'new-bill' | 'analysis' | 'history'
type LetterStatus = 'empty' | 'generating' | 'ready' | 'error'

// Must match the filter in analyze.ts and analysis/[id]/page.tsx
const STRUCTURAL_TYPES = new Set([
  'DUPLICATE_CHARGE', 'UPCODING', 'UNBUNDLING',
  'BUNDLING_VIOLATION', 'CODING_MISMATCH', 'APPEALABLE_DENIAL', 'OTHER',
])

function computeRecoverable(issues: Issue[]): number {
  return issues
    .filter(i => STRUCTURAL_TYPES.has(i.type))
    .reduce((sum, i) => sum + i.amount_at_risk, 0)
}

interface LoadedAnalysis {
  analysisId: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  totalRecoverable: number
  summary: string
  issues: Issue[]
}

interface HistoryRow {
  id: string
  createdAt: string
  fileName: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  totalRecoverable: number
}

export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), [])

  const [activeTab, setActiveTab] = useState<Tab>('new-bill')
  const [currentAnalysis, setCurrentAnalysis] = useState<LoadedAnalysis | null>(null)
  const [currentLetter, setCurrentLetter] = useState<string | null>(null)
  const [currentLetterId, setCurrentLetterId] = useState<string | null>(null)
  const [letterStatus, setLetterStatus] = useState<LetterStatus>('empty')
  const [letterError, setLetterError] = useState('')

  const [history, setHistory] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Switch to Analysis tab with a fresh analysis result from the upload
  const handleUploadSuccess = useCallback((result: { analysisId: string; analysis: Record<string, unknown> }) => {
    const raw = result.analysis
    const issues = (Array.isArray(raw.issues) ? raw.issues : []) as Issue[]
    setCurrentAnalysis({
      analysisId: result.analysisId,
      riskLevel: (raw.risk_level as LoadedAnalysis['riskLevel']) ?? 'LOW',
      totalRecoverable: computeRecoverable(issues),
      summary: (raw.summary as string) ?? '',
      issues,
    })
    setCurrentLetter(null)
    setCurrentLetterId(null)
    setLetterStatus('empty')
    setLetterError('')
    setActiveTab('analysis')
  }, [])

  // Generate (or fetch cached) letter and display inline
  async function handleGenerateLetter() {
    if (!currentAnalysis) return
    setLetterStatus('generating')
    setLetterError('')

    try {
      const res = await fetch('/api/generate-letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ analysis_id: currentAnalysis.analysisId }),
      })
      const data = await res.json()

      if (!res.ok || !data.success) {
        setLetterError(data.error ?? 'Something went wrong.')
        setLetterStatus('error')
        return
      }

      const { data: letterRow } = await supabase
        .from('letters')
        .select('content')
        .eq('id', data.letter_id)
        .single()

      if (!letterRow?.content) {
        setLetterError('Failed to load letter content.')
        setLetterStatus('error')
        return
      }

      setCurrentLetter(letterRow.content as string)
      setCurrentLetterId(data.letter_id as string)
      setLetterStatus('ready')
    } catch {
      setLetterError('Network error. Please try again.')
      setLetterStatus('error')
    }
  }

  // Load a past analysis into the Analysis tab
  async function handleLoadHistoryItem(id: string) {
    const { data: row } = await supabase
      .from('analyses')
      .select('*, documents(*)')
      .eq('id', id)
      .single()

    if (!row) return

    const issues = (Array.isArray(row.issues) ? row.issues : []) as Issue[]
    const extracted = (row.extracted_data ?? {}) as Record<string, unknown>

    setCurrentAnalysis({
      analysisId: id,
      riskLevel: (extracted.risk_level as LoadedAnalysis['riskLevel']) ?? 'LOW',
      totalRecoverable: computeRecoverable(issues),
      summary: (row.summary as string) ?? '',
      issues,
    })
    setCurrentLetter(null)
    setCurrentLetterId(null)
    setLetterStatus('empty')
    setLetterError('')

    // Load existing letter if one was already generated
    const { data: letter } = await supabase
      .from('letters')
      .select('id, content')
      .eq('analysis_id', id)
      .maybeSingle()

    if (letter) {
      setCurrentLetter(letter.content as string)
      setCurrentLetterId(letter.id as string)
      setLetterStatus('ready')
    }

    setActiveTab('analysis')
  }

  // Fetch history each time the History tab is opened
  useEffect(() => {
    if (activeTab !== 'history') return

    setHistoryLoading(true)
    supabase
      .from('analyses')
      .select('id, created_at, extracted_data, issues, documents(file_name)')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) {
          setHistory(
            data.map(row => {
              const extracted = (row.extracted_data ?? {}) as Record<string, unknown>
              const issues = (Array.isArray(row.issues) ? row.issues : []) as Issue[]
              const docs = row.documents as unknown as { file_name: string } | null
              return {
                id: row.id,
                createdAt: row.created_at,
                fileName: docs?.file_name ?? 'Unknown file',
                riskLevel: (extracted.risk_level as HistoryRow['riskLevel']) ?? 'LOW',
                totalRecoverable: computeRecoverable(issues),
              }
            })
          )
        }
        setHistoryLoading(false)
      })
  }, [activeTab, supabase])

  const uniqueIssues = currentAnalysis
    ? Array.from(new Map(currentAnalysis.issues.map(i => [i.id, i])).values())
    : []

  function switchTab(tab: Tab) {
    if (tab === 'analysis' && !currentAnalysis) return
    setActiveTab(tab)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Tab bar */}
      <div className="border-b border-gray-200 bg-white px-6">
        <div className="max-w-5xl mx-auto flex gap-1">
          {(['new-bill', 'analysis', 'history'] as Tab[]).map(tab => {
            const labels: Record<Tab, string> = {
              'new-bill': 'New Bill',
              'analysis': 'Analysis',
              'history': 'History',
            }
            const disabled = tab === 'analysis' && !currentAnalysis
            return (
              <button
                key={tab}
                type="button"
                onClick={() => switchTab(tab)}
                disabled={disabled}
                className={[
                  'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                  activeTab === tab
                    ? 'border-gray-900 text-gray-900'
                    : disabled
                    ? 'border-transparent text-gray-300 cursor-not-allowed'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                ].join(' ')}
              >
                {labels[tab]}
              </button>
            )
          })}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* New Bill Tab */}
        {activeTab === 'new-bill' && (
          <div className="max-w-xl">
            <h1 className="text-xl font-bold text-gray-900 mb-6">Analyze a medical bill</h1>
            <UploadZone onSuccess={handleUploadSuccess} />
          </div>
        )}

        {/* Analysis Tab */}
        {activeTab === 'analysis' && currentAnalysis && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            {/* Left column: results */}
            <div className="space-y-6">
              {/* Header */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div className="flex items-center gap-3 mb-3">
                  <RiskBadge level={currentAnalysis.riskLevel} />
                  <span className="text-2xl font-bold text-gray-900">
                    {currentAnalysis.totalRecoverable > 0
                      ? `$${currentAnalysis.totalRecoverable.toLocaleString()} in billing errors`
                      : 'No structural errors found'}
                  </span>
                </div>
                <p className="text-gray-600">{currentAnalysis.summary}</p>
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
            </div>

            {/* Right column: letter panel */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4">
              <h2 className="text-gray-900 font-semibold text-lg">Dispute letter</h2>

              {letterStatus === 'empty' && (
                <button
                  type="button"
                  onClick={handleGenerateLetter}
                  className="w-full bg-gray-900 text-white rounded-xl py-3 font-medium hover:bg-gray-800 transition-colors"
                >
                  Generate dispute letter →
                </button>
              )}

              {letterStatus === 'generating' && (
                <div className="flex items-center gap-3 text-gray-500 text-sm py-4">
                  <svg className="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Generating your letter...
                </div>
              )}

              {letterStatus === 'error' && (
                <div className="space-y-3">
                  <p className="text-red-600 text-sm">{letterError}</p>
                  <button
                    type="button"
                    onClick={handleGenerateLetter}
                    className="w-full bg-gray-900 text-white rounded-xl py-3 font-medium hover:bg-gray-800 transition-colors"
                  >
                    Try again
                  </button>
                </div>
              )}

              {letterStatus === 'ready' && currentLetter && (
                <div className="space-y-4">
                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 max-h-96 overflow-y-auto">
                    <pre className="whitespace-pre-wrap font-mono text-xs text-gray-900 leading-relaxed">
                      {currentLetter}
                    </pre>
                  </div>
                  <div className="flex gap-3">
                    <CopyLetterButton content={currentLetter} />
                    {currentLetterId && <DownloadPdfButton letterId={currentLetterId} />}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div>
            <h1 className="text-xl font-bold text-gray-900 mb-6">Past analyses</h1>

            {historyLoading && (
              <p className="text-gray-500 text-sm">Loading...</p>
            )}

            {!historyLoading && history.length === 0 && (
              <p className="text-gray-500 text-sm">No past analyses found.</p>
            )}

            {!historyLoading && history.length > 0 && (
              <div className="space-y-2">
                {history.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => handleLoadHistoryItem(row.id)}
                    className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-gray-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <RiskBadge level={row.riskLevel} />
                        <span className="text-gray-900 font-medium text-sm truncate">
                          {row.fileName}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 text-sm">
                        {row.totalRecoverable > 0 && (
                          <span className="text-orange-700 font-medium">
                            ${row.totalRecoverable.toLocaleString()}
                          </span>
                        )}
                        <span className="text-gray-400">
                          {new Date(row.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
