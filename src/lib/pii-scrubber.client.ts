// Client-side only — never import this from server components or API routes.
// Renders each PDF page, OCRs it via Tesseract, paints over PII, and exports JPGs.

import type { Worker as TesseractWorker } from 'tesseract.js'

export type ScrubPage = {
  originalCanvas: HTMLCanvasElement  // raw render, no redactions — source for eraser
  redactedCanvas: HTMLCanvasElement  // redacted version, live-edited by eraser
  toFile: (index: number) => Promise<File>  // exports current redactedCanvas state to JPG
}

export type ScrubResult =
  | { ok: true; pages: ScrubPage[] }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Bbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface OcrWord {
  text: string
  confidence: number
  bbox: Bbox
}

interface OcrLine {
  words: OcrWord[]  // sorted left-to-right
}

// ---------------------------------------------------------------------------
// PII label patterns
// Tested against N-grams (1/2/3 consecutive words joined by space).
// ---------------------------------------------------------------------------

const PII_LABEL_PATTERNS: RegExp[] = [
  // Patient identity — single word (require colon to avoid matching mid-sentence nouns
  // e.g. "Office visit established patient" must NOT trigger)
  /^patient:$/i,
  /^insured:$/i,
  /^subscriber:$/i,
  /^guarantor:$/i,
  /^member:$/i,
  /^insurance:$/i,
  // "Name:" — colon required to avoid matching "name" in free text
  /^name:$/i,
  // Patient identity — multi-word (matched via 2/3-gram)
  /^patient\s+name:?$/i,
  /^insured\s+name:?$/i,
  /^subscriber\s+name:?$/i,
  /^guarantor\s+name:?$/i,
  /^responsible\s+party:?$/i,
  /^member\s+name:?$/i,
  // Date of birth
  /^(?:date\s+of\s+birth|dob|d\.o\.b\.?):?$/i,
  /^birth\s*date:?$/i,
  /^birthdate:?$/i,
  // Identifiers — single word
  /^(?:tax\s+id|ein):?$/i,
  // Identifiers — multi-word
  /^account\s+number:?$/i,
  /^group\s+number:?$/i,
  /^(?:account|acct)\.?\s*#:?$/i,
  /^(?:member|subscriber)\s+(?:id|#|no\.?|number):?$/i,
  /^(?:patient|account)\s+(?:id|#|acct\.?|number):?$/i,
  /^(?:insurance|policy|group|claim)\s+(?:id|#|no\.?|number):?$/i,
  /^(?:medicaid|medicare)\s+(?:id|#|no\.?|number):?$/i,
  /^(?:social\s+security|ssn|ss#):?$/i,
  /^(?:mrn|medical\s+record\s+(?:number|no\.?|#)):?$/i,
  /^(?:plan|rx)\s+(?:id|#|number):?$/i,
  /^(?:rx\s+bin|rx\s+pcn|rx\s+grp):?$/i,
  // Contact
  /^(?:phone|tel\.?|telephone|cell):?$/i,
  /^(?:email|e-mail):?$/i,
  /^npi:?$/i,
]

function isPiiLabelPhrase(words: OcrWord[], start: number, len: number): boolean {
  const phrase = words.slice(start, start + len).map((w) => w.text).join(' ')
  return PII_LABEL_PATTERNS.some((re) => re.test(phrase))
}

// ---------------------------------------------------------------------------
// pdf.js — lazy singleton
// ---------------------------------------------------------------------------

let pdfLibCache: typeof import('pdfjs-dist') | null = null

async function getPdfLib() {
  if (!pdfLibCache) {
    const lib = await import('pdfjs-dist')
    lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    pdfLibCache = lib
  }
  return pdfLibCache
}

// ---------------------------------------------------------------------------
// Tesseract worker — module-level singleton
// Initialized once per browser session; reused across scrubPdf calls.
// ---------------------------------------------------------------------------

let workerPromise: Promise<TesseractWorker> | null = null

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await import('tesseract.js')
      // OEM 1 = LSTM_ONLY (neural net — most accurate)
      const worker = await Tesseract.createWorker('eng', 1)
      return worker
    })()
  }
  return workerPromise
}

// ---------------------------------------------------------------------------
// Warm-up: call this when the user selects a PDF so WASM init overlaps with
// the user filling in state/county fields.
// ---------------------------------------------------------------------------

export async function warmScrubber(): Promise<void> {
  await getTesseractWorker()
}

// ---------------------------------------------------------------------------
// Render a PDF page to a canvas using a pre-computed viewport
// ---------------------------------------------------------------------------

async function renderPageToCanvas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewport: any
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)

  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas
}

// ---------------------------------------------------------------------------
// PDF text layer extraction — primary method for digital PDFs.
// Uses page.getTextContent() for exact strings + coordinates, bypassing OCR.
// Falls back to Tesseract for scanned PDFs (returns [] when too few items).
// ---------------------------------------------------------------------------

function groupIntoLines(words: OcrWord[]): OcrLine[] {
  if (words.length === 0) return []
  words.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  const lines: OcrLine[] = []
  let cur: OcrWord[] = [words[0]]
  for (let i = 1; i < words.length; i++) {
    const last = cur[cur.length - 1]
    const h = last.bbox.y1 - last.bbox.y0
    if (Math.abs(words[i].bbox.y0 - last.bbox.y0) <= Math.max(h * 0.6, 4)) {
      cur.push(words[i])
    } else {
      lines.push({ words: [...cur].sort((a, b) => a.bbox.x0 - b.bbox.x0) })
      cur = [words[i]]
    }
  }
  if (cur.length) lines.push({ words: cur.sort((a, b) => a.bbox.x0 - b.bbox.x0) })
  return lines
}

async function extractLinesFromPdfTextLayer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewport: any,
  scale: number
): Promise<OcrLine[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tc = await page.getTextContent()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (tc.items as any[]).filter((i) => typeof i.str === 'string' && i.str.trim())

  // Fewer than 5 items almost certainly means a scanned page — fall back to Tesseract
  if (items.length < 5) return []

  const words: OcrWord[] = []

  for (const item of items) {
    // transform[4,5] = x,y in PDF user space; convertToViewportPoint maps to canvas space
    const [cx, cy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    const cw = Math.abs(item.width) * scale
    const ch = Math.max(Math.abs(item.height) * scale, 8)

    // Each TextItem may contain a whole phrase — split on whitespace so our N-gram
    // scanner can match individual label words (e.g. "Date" + "of" + "Birth")
    const parts = (item.str as string).trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue

    // Distribute width proportionally across parts
    const perCharW = cw / Math.max(item.str.length, 1)
    let xOff = cx
    for (const part of parts) {
      const pw = part.length * perCharW
      words.push({
        text: part,
        confidence: 100,
        bbox: { x0: xOff, y0: cy - ch, x1: xOff + pw, y1: cy },
      })
      xOff += pw + perCharW  // approximate space width
    }
  }

  return groupIntoLines(words)
}

// ---------------------------------------------------------------------------
// Flatten Tesseract's block→paragraph→line→word hierarchy into lines.
// Each line's words are sorted left-to-right.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenLines(page: any): OcrLine[] {
  const lines: OcrLine[] = []
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words: OcrWord[] = (line.words ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((w: any) => w.confidence >= 40)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((w: any) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }))
          .sort((a: OcrWord, b: OcrWord) => a.bbox.x0 - b.bbox.x0)
        if (words.length > 0) lines.push({ words })
      }
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Union bounding boxes of a set of words, adding padding
// ---------------------------------------------------------------------------

function unionBbox(words: OcrWord[], padding = 4): Bbox {
  return {
    x0: Math.max(0, Math.min(...words.map((w) => w.bbox.x0)) - padding),
    y0: Math.max(0, Math.min(...words.map((w) => w.bbox.y0)) - padding),
    x1: Math.max(...words.map((w) => w.bbox.x1)) + padding,
    y1: Math.max(...words.map((w) => w.bbox.y1)) + padding,
  }
}

// ---------------------------------------------------------------------------
// Scan each line with N-gram matching (1/2/3 words) to find PII label+value
// pairs. Handles two-column layouts by stopping value collection at the next
// label on the same line.
// ---------------------------------------------------------------------------

function detectPiiRegions(lines: OcrLine[], canvasWidth: number): Bbox[] {
  const redactions: Bbox[] = []

  for (let li = 0; li < lines.length; li++) {
    const words = lines[li].words
    let i = 0

    while (i < words.length) {
      // Try longest N-gram first (3→2→1) to prefer precise label matches
      let labelLen = 0
      for (const n of [3, 2, 1]) {
        if (i + n <= words.length && isPiiLabelPhrase(words, i, n)) {
          labelLen = n
          break
        }
      }

      if (labelLen === 0) { i++; continue }

      // Collect value words after the label on the same line, stopping when
      // we hit the next PII label (handles two-column layouts).
      const valueWords: OcrWord[] = []
      let j = i + labelLen
      while (j < words.length) {
        let nextIsLabel = false
        for (const n of [3, 2, 1]) {
          if (j + n <= words.length && isPiiLabelPhrase(words, j, n)) {
            nextIsLabel = true
            break
          }
        }
        if (nextIsLabel) break
        valueWords.push(words[j++])
      }

      if (valueWords.length > 0) {
        redactions.push(unionBbox(valueWords))
        i = j  // continue scanning from after the value
      } else if (li + 1 < lines.length) {
        // No value on this line — check the next line (vertical form layout)
        const labelX0 = words[i].bbox.x0
        const nextWords = lines[li + 1].words.filter((w) => w.bbox.x0 >= labelX0 - 20)
        const nextValueWords: OcrWord[] = []
        for (const w of nextWords) {
          if (isPiiLabelPhrase([w], 0, 1)) break
          nextValueWords.push(w)
        }
        if (nextValueWords.length > 0) redactions.push(unionBbox(nextValueWords))
        i += labelLen
      } else {
        // Fallback: draw a 200px-wide box to the right of the last label word
        const lastLabelWord = words[i + labelLen - 1]
        redactions.push({
          x0: lastLabelWord.bbox.x1 + 2,
          y0: lastLabelWord.bbox.y0 - 4,
          x1: Math.min(canvasWidth, lastLabelWord.bbox.x1 + 202),
          y1: lastLabelWord.bbox.y1 + 4,
        })
        i += labelLen
      }
    }
  }

  return redactions
}

// ---------------------------------------------------------------------------
// Paint redaction rectangles onto the canvas
// ---------------------------------------------------------------------------

function applyRedactions(ctx: CanvasRenderingContext2D, redactions: Bbox[]): void {
  ctx.fillStyle = '#000000'
  for (const r of redactions) {
    ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
  }
}

// ---------------------------------------------------------------------------
// Export a canvas to a JPG File
// ---------------------------------------------------------------------------

function canvasToJpgFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to export canvas to JPEG'))
          return
        }
        resolve(new File([blob], filename, { type: 'image/jpeg' }))
      },
      'image/jpeg',
      0.92
    )
  })
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function scrubPdf(
  file: File,
  onProgress?: (msg: string) => void
): Promise<ScrubResult> {
  const MAX_PAGES = 20

  try {
    onProgress?.('Initializing document scanner...')

    // Load pdf.js eagerly; only init Tesseract if we find a scanned page
    const pdfjsLib = await getPdfLib()

    const arrayBuffer = await file.arrayBuffer()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pdf: any
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('password')) {
        return { ok: false, reason: 'This PDF is password-protected. Please remove the password before uploading.' }
      }
      throw err
    }

    const totalPages = pdf.numPages
    const numPages = Math.min(totalPages, MAX_PAGES)

    if (totalPages > MAX_PAGES) {
      onProgress?.(`Document has ${totalPages} pages — processing first ${MAX_PAGES}...`)
    }

    const scrubPages: ScrubPage[] = []
    // Lazily initialized only if a scanned page is detected
    let worker: TesseractWorker | null = null

    for (let i = 1; i <= numPages; i++) {
      onProgress?.(`Scanning page ${i} of ${numPages}...`)

      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 2.0 })

      // Render the original (no redactions) — used as eraser source
      const originalCanvas = await renderPageToCanvas(page, viewport)

      // Clone to a separate canvas that will receive the redaction paint
      const redactedCanvas = document.createElement('canvas')
      redactedCanvas.width = originalCanvas.width
      redactedCanvas.height = originalCanvas.height
      const ctx = redactedCanvas.getContext('2d')!
      ctx.drawImage(originalCanvas, 0, 0)

      // Try PDF text layer first (exact strings, no OCR guessing)
      let lines = await extractLinesFromPdfTextLayer(page, viewport, 2.0)

      if (lines.length === 0) {
        // Scanned page — fall back to Tesseract OCR
        if (!worker) {
          onProgress?.(`Scanning page ${i} of ${numPages} (OCR)...`)
          worker = await getTesseractWorker()
        }
        // Must request { blocks: true } — Tesseract v7 defaults to { text: true } only
        const result = await worker.recognize(originalCanvas, {}, { blocks: true })
        lines = flattenLines(result.data)
      }

      const redactions = detectPiiRegions(lines, originalCanvas.width)
      applyRedactions(ctx, redactions)

      scrubPages.push({
        originalCanvas,
        redactedCanvas,
        toFile: (index: number) => canvasToJpgFile(redactedCanvas, `page_${index}.jpg`),
      })
    }

    return { ok: true, pages: scrubPages }
  } catch (err) {
    console.error('[pii-scrubber] Error:', err)
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Unknown error during PII scrubbing. Please try again.',
    }
  }
}
