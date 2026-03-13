import UploadZone from '@/components/UploadZone'

export default function UploadPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Upload your bill
        </h1>
        <p className="text-gray-500 mb-8">
          Upload a medical bill or insurance denial letter. We&apos;ll analyze
          it and generate a dispute letter ready to send.
        </p>
        <UploadZone />
      </div>
    </div>
  )
}
