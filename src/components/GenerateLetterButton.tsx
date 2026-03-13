'use client'

export default function GenerateLetterButton() {
  return (
    <button
      type="button"
      onClick={() => alert('Coming soon')}
      className="w-full bg-gray-900 text-white rounded-xl py-3 font-medium hover:bg-gray-800 flex items-center justify-center gap-2"
    >
      Generate dispute letter →
    </button>
  )
}
