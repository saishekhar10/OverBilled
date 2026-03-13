import path from 'path'
import fs from 'fs'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../.env.local') })

async function main() {
  const { createClient } = await import('@supabase/supabase-js')

  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npx tsx scripts/test-route-analyze.ts <path-to-pdf>')
    process.exit(1)
  }

  const absolutePath = path.resolve(filePath)
  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`)
    process.exit(1)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Step 4: Create a disposable test user
  const testEmail = `test-${Date.now()}@overbilled-test.invalid`
  const testPassword = `TestPass-${Date.now()}!`

  console.log(`Creating test user: ${testEmail}`)
  const { data: createData, error: createError } = await supabase.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  })

  if (createError || !createData.user) {
    console.error('Failed to create test user:', createError?.message)
    process.exit(1)
  }

  const userId = createData.user.id

  // Step 5: Sign in to get a real JWT
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  })

  if (signInError || !signInData.session) {
    console.error('Failed to sign in:', signInError?.message)
    await supabase.auth.admin.deleteUser(userId)
    process.exit(1)
  }

  const accessToken = signInData.session.access_token

  // Step 6: Send multipart POST to /api/analyze
  const fileBuffer = fs.readFileSync(absolutePath)
  const fileName = path.basename(absolutePath)

  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fileName)

  console.log(`Sending ${fileName} to http://localhost:3000/api/analyze ...`)

  let response: Response
  try {
    response = await fetch('http://localhost:3000/api/analyze', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    })
  } catch (err) {
    console.error('Request failed — is the dev server running on port 3000?', (err as Error).message)
    await supabase.auth.admin.deleteUser(userId)
    process.exit(1)
  }

  // Step 7: Pretty-print the response
  const json = await response.json()
  console.log(JSON.stringify(json, null, 2))

  // Step 8: Clean up test user
  const { error: deleteError } = await supabase.auth.admin.deleteUser(userId)
  if (deleteError) {
    console.warn(`Warning: failed to delete test user ${userId}:`, deleteError.message)
  } else {
    console.log(`Test user ${testEmail} deleted.`)
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
