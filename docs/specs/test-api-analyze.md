# Spec: Test Script for POST /api/analyze

## Overview
A one-off test script that hits the /api/analyze route directly using the
Supabase service role key to bypass authentication. Used to validate the
route works end-to-end before auth pages are built.

**Delete this script before shipping.**

---

## File Location
`scripts/test-route-analyze.ts`

---

## Environment Variables Required
Add to `.env.local` if not already present:
```
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Get from: Supabase Dashboard → Project Settings → API → service_role (secret)

---

## What the Script Does
1. Loads environment variables from `.env.local` using dotenv
2. Reads a PDF file path from `process.argv[2]`
3. Starts the Next.js dev server is assumed to already be running on port 3000
4. Creates a test user session using the service role key via
   `supabase.auth.admin.createUser()` with a disposable test email
5. Signs in as that user to get a real JWT access token
6. Sends a multipart/form-data POST request to `http://localhost:3000/api/analyze`
   with the JWT in the Authorization header as `Bearer {token}`
7. Pretty-prints the full JSON response
8. Cleans up — deletes the test user after the request completes

---

## Implementation Notes
- Use `@supabase/supabase-js` with the service role key to create/delete the test user
- Use native `fetch` with `FormData` to send the multipart request
- The Authorization header format must be: `Bearer {access_token}`
- The Next.js dev server must be running (`npm run dev`) in a separate terminal
  before executing this script
- Use `supabase.auth.admin.createUser({ email, password, email_confirm: true })`
  to create the test user — `email_confirm: true` skips the email verification step
- After creating the user, sign in with `supabase.auth.signInWithPassword()`
  to get the JWT — do not try to use the service role key as the JWT itself

---

## Run Command
```bash
# Terminal 1 — start the dev server
npm run dev

# Terminal 2 — run the test
npx tsx scripts/test-route-analyze.ts scripts/test_bills/bill_1_er_visit.pdf
```

---

## Expected Output
```json
{
  "success": true,
  "document_id": "uuid",
  "analysis_id": "uuid",
  "analysis": {
    "document_type": "medical_bill",
    "patient": { ... },
    ...
  }
}
```

---

## Cleanup Reminder
- This script creates a real user in your Supabase auth table on every run
- It deletes the user after the test but verify in Supabase Dashboard → Auth → Users
- Remove this script and `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` before deploying
