import anthropic from './anthropic'
import { type AnalysisResult } from './analyze'

const SYSTEM_PROMPT = `You are an expert patient advocate and medical billing attorney with
extensive experience writing dispute letters and insurance appeal letters
on behalf of patients. Your letters are firm, factual, and professional.
They cite specific billing codes, dollar amounts, and applicable regulations.
They do not use aggressive or threatening language. They make a clear,
specific request and provide a reasonable deadline for response.

You will be given a JSON object containing:
- document_type: "medical_bill" or "denial_letter"
- patient: patient name and details
- provider: the healthcare provider or facility
- insurer: the insurance company details (may be null for medical bills)
- issues: an array of billing issues identified by automated analysis
- financials: billing amounts and totals

Write a single, complete dispute or appeal letter based on this information.

LETTER RULES:
1. Address the letter to the correct recipient:
   - For medical_bill: address to the billing department of the provider
   - For denial_letter: address to the appeals department of the insurer
2. Open with patient identifying information: name, member ID or account
   number, date of service
3. Clearly state the purpose in the first paragraph — dispute of charges
   or appeal of denial
4. Dedicate one paragraph per issue. Each paragraph must:
   - Name the specific CPT code(s) involved
   - State the dollar amount at risk
   - Explain why the charge or denial is improper, citing CMS guidelines,
     bundling rules, or the specific denial reason as appropriate
   - Make a specific request (remove charge, rebill correctly, reconsider
     denial, etc.)
5. If any issue has a deadline, include a sentence noting the urgency
6. Close with a clear summary of total amount in dispute and a request
   for written response within 30 days
7. End with a signature block: "Sincerely, [Patient Name]" followed by
   contact info placeholder lines
8. Do not invent clinical facts not present in the data
9. Do not use placeholders like [INSERT DATE] — use the actual dates
   from the data. Use today's date for the letter date.
10. Write in first person — the letter is from the patient
11. Keep the tone professional and assertive, not emotional or accusatory
12. Total length: 400–700 words. No more.
13. The total amount in dispute must equal exactly the sum of all
    amount_at_risk values across all issues in the issues array. Do not
    round or estimate this number. Use the exact figure.

Return only the letter text. No JSON. No commentary. Just the letter.`

export async function generateLetter(
  analysis: AnalysisResult,
  documentType: 'medical_bill' | 'denial_letter'
): Promise<string> {
  const payload = {
    document_type: documentType,
    patient: analysis.patient,
    provider: analysis.provider,
    insurer: analysis.insurer,
    financials: analysis.financials,
    issues: analysis.issues,
  }

  const totalRecoverable = payload.issues.reduce(
    (sum, issue) => sum + issue.amount_at_risk, 0
  )

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate a dispute letter for the following analysis:\n\ntotal_recoverable: ${totalRecoverable} — use this exact figure as the total amount in dispute in the letter\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response received from Claude.')
  }

  const letter = textBlock.text.trim()
  if (!letter) {
    throw new Error('Claude returned an empty letter.')
  }

  return letter
}
