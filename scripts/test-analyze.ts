import fs from 'fs'
import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../.env.local') })

async function main() {
  const { analyzeDocument } = await import('../src/lib/analyze')

  const filePath = process.argv[2]

  if (!filePath) {
    console.error('Usage: npx tsx scripts/test-analyze.ts <path-to-pdf-or-image>')
    process.exit(1)
  }

  const absolutePath = path.resolve(filePath)

  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`)
    process.exit(1)
  }

  const ext = path.extname(absolutePath).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }

  const mimeType = mimeMap[ext]
  if (!mimeType) {
    console.error(`Unsupported file extension: ${ext}`)
    process.exit(1)
  }

  console.log(`Analyzing: ${absolutePath}`)
  console.log(`MIME type: ${mimeType}`)
  console.log('Sending to Claude...\n')

  const buffer = fs.readFileSync(absolutePath)
  const result = await analyzeDocument(buffer, mimeType, 'TX', 'HARRIS')

  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
