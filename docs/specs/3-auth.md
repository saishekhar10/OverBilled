# Spec 3: Authentication

## Overview
Email/password authentication using Supabase Auth. Covers sign up, login,
logout, a Supabase trigger to auto-create the public users row on signup,
and route protection via middleware. No OAuth for MVP.

---

## Files to Create
- `src/app/(auth)/signup/page.tsx`
- `src/app/(auth)/login/page.tsx`
- `src/app/(auth)/layout.tsx`
- `src/app/auth/callback/route.ts`
- `supabase/migrations/create_users_trigger.sql`

## Files to Update
- `src/middleware.ts` — already exists, update to protect routes

---

## 1. Supabase Trigger

Create `supabase/migrations/create_users_trigger.sql`:

```sql
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, full_name)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

Run this in the Supabase SQL editor before testing auth.
This ensures every new signup automatically gets a row in public.users.

---

## 2. Auth Callback Route

`src/app/auth/callback/route.ts`

Handles the Supabase email confirmation redirect. Exchanges the code
for a session and redirects to /dashboard.

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          }
        }
      }
    )
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
```

---

## 3. Auth Layout

`src/app/(auth)/layout.tsx`

Simple centered layout for auth pages. No navigation.

```tsx
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        {children}
      </div>
    </div>
  )
}
```

---

## 4. Sign Up Page

`src/app/(auth)/signup/page.tsx`

### Fields
- Full name (text input) — stored in user_metadata, used by trigger to
  populate public.users.full_name
- Email (email input)
- Password (password input, min 8 characters)
- Submit button

### Behaviour
- Use Supabase client-side `signUp()` with emailRedirectTo pointing to
  `/auth/callback`
- Pass full_name in the options.data object so it's available in
  raw_user_meta_data for the trigger
- On success: show a message — "Check your email to confirm your account"
- On error: show the error message inline below the form
- Link to /login at the bottom — "Already have an account? Log in"

### Supabase call
```typescript
const { error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    data: { full_name: fullName },
    emailRedirectTo: `${window.location.origin}/auth/callback`
  }
})
```

---

## 5. Login Page

`src/app/(auth)/login/page.tsx`

### Fields
- Email (email input)
- Password (password input)
- Submit button

### Behaviour
- Use Supabase client-side `signInWithPassword()`
- On success: redirect to /dashboard using Next.js router.push()
- On error: show the error message inline below the form
- Link to /signup at the bottom — "Don't have an account? Sign up"

### Supabase call
```typescript
const { error } = await supabase.auth.signInWithPassword({ email, password })
if (!error) router.push('/dashboard')
```

---

## 6. Middleware Update

Update `src/middleware.ts` to protect routes:

### Protected routes (require auth)
- /dashboard
- /upload
- /analysis/:path*
- /letter/:path*

### Public routes (no auth required)
- /login
- /signup
- /auth/callback
- / (landing page)

### Logic
- If unauthenticated user hits a protected route → redirect to /login
- If authenticated user hits /login or /signup → redirect to /dashboard
- Use createServerClient with cookies in middleware (already set up
  in existing middleware.ts — just add the route protection logic)

---

## 7. Placeholder Dashboard Page

Create `src/app/dashboard/page.tsx` — a minimal placeholder so the
post-login redirect has somewhere to land.

```tsx
export default function DashboardPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="text-gray-500 mt-2">You are logged in.</p>
    </div>
  )
}
```

---

## Styling Notes
- Use Tailwind only — no component libraries
- Forms should look clean and minimal — white card, subtle shadow,
  rounded corners
- Inputs: full width, border, rounded, focus ring in a neutral color
- Submit button: full width, dark background, white text
- Error messages: red text, small, below the form

---

## Automated Testing

After implementing all files above, run the following tests automatically.
Do not ask for confirmation — execute each step, resolve any errors
encountered, and report the final result.

### Setup
```bash
# Start the dev server in the background
npm run dev &
DEV_PID=$!

# Wait for the server to be ready
npx wait-on http://localhost:3000 --timeout 30000
```

### Test 1 — Pages render without error
```bash
# Login page returns 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login
# Expected: 200

# Signup page returns 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/signup
# Expected: 200
```

### Test 2 — Protected route redirects unauthenticated user
```bash
# Dashboard should redirect to /login (302 or 307)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/dashboard
# Expected: 302 or 307
```

### Test 3 — Signup creates user and public.users row
```bash
# Use the Supabase admin API to create a test user and verify
# the trigger fires and creates a public.users row
npx tsx scripts/test-auth.ts
```

Create `scripts/test-auth.ts` as part of this spec:
- Uses SUPABASE_SERVICE_ROLE_KEY from .env.local
- Creates a test user via supabase.auth.admin.createUser()
  with email_confirm: true and full_name in user_metadata
- Queries public.users table to verify a row was created
  with the correct id and full_name
- Deletes the test user after verification
- Logs PASS or FAIL with details for each assertion
- Exits with code 1 if any assertion fails

### Teardown
```bash
# Kill the dev server
kill $DEV_PID
```

### Error Resolution Rules
If any test fails, apply the following resolution steps before reporting:

1. **Page returns non-200** — check for TypeScript/import errors in the
   page file, fix and retest
2. **Dashboard does not redirect** — middleware matcher pattern is likely
   wrong, update the matcher config and retest
3. **public.users row not created** — trigger SQL was not run or failed
   silently. Re-run the trigger SQL via Supabase JS admin client in the
   test script itself, then retry
4. **wait-on not found** — install it: `npm install --save-dev wait-on`
   then retry
5. **Any TypeScript compilation error** — run `npx tsc --noEmit`, fix
   all type errors, then retest

Report the outcome of every test as PASS or FAIL with the actual vs
expected result. If all tests pass, confirm implementation is complete.
