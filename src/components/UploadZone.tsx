'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 10 * 1024 * 1024

const US_STATES = [
  { value: '', label: 'Select state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'DC', label: 'District of Columbia' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' },
]

type State = 'idle' | 'selected' | 'uploading' | 'error'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function UploadZone() {
  const [state, setState] = useState<State>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [providerState, setProviderState] = useState('')
  const [providerCounty, setProviderCounty] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const validate = (f: File): string | null => {
    if (!ACCEPTED_TYPES.includes(f.type)) return 'Unsupported file type. Please upload a PDF, JPG, PNG, or WebP.'
    if (f.size > MAX_SIZE) return 'File exceeds 10MB limit.'
    return null
  }

  const selectFile = useCallback((f: File) => {
    const err = validate(f)
    if (err) {
      setError(err)
      setState('error')
      return
    }
    setFile(f)
    setError('')
    setState('selected')
  }, [])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => setIsDragOver(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) selectFile(dropped)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (selected) selectFile(selected)
  }

  const handleZoneClick = () => {
    if (state !== 'uploading') inputRef.current?.click()
  }

  const handleSubmit = async () => {
    if (!file || !providerState || !providerCounty) {
      setError('Please select a file and enter the provider\'s state and county.')
      return
    }
    setState('uploading')
    setError('')

    const formData = new FormData()
    formData.append('file', file)
    formData.append('provider_state', providerState.trim().toUpperCase())
    formData.append('provider_county', providerCounty.trim().toUpperCase())

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        setError(data.error ?? 'Something went wrong. Please try again.')
        setState('error')
        return
      }

      router.push(`/analysis/${data.analysis_id}`)
    } catch {
      setError('Network error. Please try again.')
      setState('error')
    }
  }

  const borderClass = isDragOver
    ? 'border-blue-400 bg-blue-50'
    : state === 'error'
    ? 'border-red-400 bg-white'
    : 'border-gray-300 bg-white'

  if (state === 'uploading') {
    return (
      <div className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center bg-white">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="text-gray-900 font-medium">Analyzing your document...</p>
          <p className="text-gray-500 text-sm">This usually takes 10–20 seconds</p>
        </div>
      </div>
    )
  }

  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 bg-white'

  return (
    <div>
      {/* Provider location */}
      <div className="mb-4">
        <p className="text-gray-700 font-medium text-sm mb-3">Provider location</p>
        <div className="flex gap-3">
          <div style={{ width: '40%' }}>
            <label className="block text-gray-500 text-xs font-medium mb-1">State</label>
            <select
              value={providerState}
              onChange={(e) => setProviderState(e.target.value)}
              className={inputClass}
            >
              {US_STATES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div style={{ width: '55%' }}>
            <label className="block text-gray-500 text-xs font-medium mb-1">County</label>
            <input
              type="text"
              value={providerCounty}
              onChange={(e) => setProviderCounty(e.target.value)}
              placeholder="e.g. Harris County"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* File drop zone */}
      <div
        className={`border-2 border-dashed rounded-xl transition-colors cursor-pointer ${borderClass}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleZoneClick}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          className="hidden"
          onChange={handleInputChange}
        />

        {state === 'idle' || state === 'error' ? (
          <div className="p-10 text-center">
            <svg className="mx-auto h-10 w-10 text-gray-400 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <p className="text-gray-900 font-medium mb-1">Drag and drop your file here</p>
            <p className="text-gray-500 text-sm mb-1">or click to browse</p>
            <p className="text-gray-400 text-xs">PDF, JPG, PNG up to 10MB</p>
          </div>
        ) : (
          <div className="p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <span className="text-2xl">📄</span>
              <div>
                <p className="text-gray-900 font-medium">{file!.name}</p>
                <p className="text-gray-500 text-sm">
                  {formatBytes(file!.size)}{' '}
                  <button
                    type="button"
                    onClick={() => { setState('idle'); setFile(null) }}
                    className="underline text-gray-500 hover:text-gray-700 ml-1"
                  >
                    Change file
                  </button>
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!providerState || !providerCounty}
              className="w-full bg-gray-900 text-white rounded-lg py-2.5 font-medium hover:bg-gray-800 disabled:opacity-50"
            >
              Analyze document
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 text-red-600 text-sm">{error}</p>
      )}
    </div>
  )
}
