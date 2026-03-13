import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !serviceRoleKey) {
  console.error('FAIL: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TEST_EMAIL = `test-auth-${Date.now()}@example.com`
const TEST_FULL_NAME = 'Test Auth User'

let passed = 0
let failed = 0
let userId: string | null = null

function pass(msg: string) {
  console.log(`PASS: ${msg}`)
  passed++
}

function fail(msg: string) {
  console.log(`FAIL: ${msg}`)
  failed++
}

async function applyTriggerSql() {
  // Try Supabase Management API if SUPABASE_ACCESS_TOKEN is available
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]

  if (accessToken && projectRef) {
    const triggerSql = `
      create or replace function handle_new_user()
      returns trigger as $$
      begin
        insert into public.users (id, full_name)
        values (new.id, new.raw_user_meta_data->>'full_name')
        on conflict (id) do nothing;
        return new;
      end;
      $$ language plpgsql security definer;

      drop trigger if exists on_auth_user_created on auth.users;

      create trigger on_auth_user_created
        after insert on auth.users
        for each row execute function handle_new_user();
    `
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: triggerSql }),
    })
    if (res.ok) {
      console.log('INFO: Applied trigger SQL via Management API')
      return true
    } else {
      const body = await res.text()
      console.log(`WARN: Management API returned ${res.status}: ${body}`)
    }
  } else if (accessToken) {
    console.log('WARN: SUPABASE_ACCESS_TOKEN is set but could not parse project ref from URL')
  }
  return false
}

async function cleanup() {
  if (userId) {
    await supabase.auth.admin.deleteUser(userId)
  }
}

async function run() {
  // Step 1: Try to apply the trigger SQL programmatically
  const triggerApplied = await applyTriggerSql()
  if (!triggerApplied) {
    console.log('INFO: Could not apply trigger SQL automatically.')
    console.log('INFO: To apply automatically, add SUPABASE_ACCESS_TOKEN to .env.local')
    console.log('INFO: (Get a token at https://supabase.com/dashboard/account/tokens)')
    console.log('INFO: Otherwise, run supabase/migrations/create_users_trigger.sql manually in the Supabase SQL editor.')
  }

  // Step 2: Create test user via admin API
  const { data: createData, error: createError } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: 'testpassword123',
    email_confirm: true,
    user_metadata: { full_name: TEST_FULL_NAME },
  })

  if (createError || !createData.user) {
    fail(`Could not create test user: ${createError?.message}`)
    process.exit(1)
  }

  userId = createData.user.id
  pass(`Created auth user with id ${userId}`)

  // Step 3: Wait for trigger to fire
  await new Promise((r) => setTimeout(r, 1500))

  // Step 4: Check if trigger auto-created the public.users row
  const { data: publicUser, error: queryError } = await supabase
    .from('users')
    .select('id, full_name')
    .eq('id', userId)
    .single()

  if (queryError || !publicUser) {
    // Trigger did not fire — try to verify the schema is correct by inserting manually
    console.log('INFO: Trigger did not fire (SQL migration not applied). Verifying schema manually...')

    const { error: insertError } = await supabase
      .from('users')
      .insert({ id: userId, full_name: TEST_FULL_NAME })

    if (insertError) {
      fail(`public.users table schema invalid or inaccessible: ${insertError.message}`)
    } else {
      fail(`Trigger on_auth_user_created did not fire — public.users row was not auto-created.`)
      console.log('      Run supabase/migrations/create_users_trigger.sql in the Supabase SQL editor.')

      // Verify the manually inserted row
      const { data: manualRow } = await supabase
        .from('users')
        .select('id, full_name')
        .eq('id', userId)
        .single()

      if (manualRow?.full_name === TEST_FULL_NAME) {
        pass(`public.users schema is correct (manual insert verified)`)
      }
    }
  } else {
    pass(`public.users row auto-created by trigger for user ${userId}`)

    if (publicUser.full_name === TEST_FULL_NAME) {
      pass(`full_name matches: "${publicUser.full_name}"`)
    } else {
      fail(`full_name mismatch — expected "${TEST_FULL_NAME}", got "${publicUser.full_name}"`)
    }
  }

  // Step 5: Clean up
  const { error: deleteError } = await supabase.auth.admin.deleteUser(userId)
  if (deleteError) {
    console.log(`WARN: Could not delete test user: ${deleteError.message}`)
  } else {
    pass(`Deleted test user ${userId}`)
  }
  userId = null

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch(async (err) => {
  console.error('Unexpected error:', err)
  await cleanup()
  process.exit(1)
})
