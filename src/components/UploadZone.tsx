'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 10 * 1024 * 1024

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
    if (!file) return
    setState('uploading')
    setError('')

    const formData = new FormData()
    formData.append('file', file)

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

  return (
    <div>
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
