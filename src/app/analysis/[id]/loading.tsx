export default function AnalysisLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-gray-900 mb-4" />
      <p className="text-gray-600 text-sm">Loading your analysis...</p>
    </div>
  )
}
