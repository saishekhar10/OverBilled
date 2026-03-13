'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface GenerateLetterButtonProps {
  analysisId: string
}

export default function GenerateLetterButton({ analysisId }: GenerateLetterButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleClick() {
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/generate-letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ analysis_id: analysisId }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        setError(data.error ?? 'Something went wrong. Please try again.')
        setLoading(false)
        return
      }

      router.push(`/letter/${data.letter_id}`)
    } catch {
      setError('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full bg-gray-900 text-white rounded-xl py-3 font-medium hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading ? 'Generating letter...' : 'Generate dispute letter →'}
      </button>
      {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
    </div>
  )
}
