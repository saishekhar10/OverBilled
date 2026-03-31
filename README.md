# OverBilled

Upload a medical bill or denial letter and get a dispute letter ready to send in minutes.

## Tech Stack

- **Next.js 16** (App Router) + **TypeScript** + **React 19**
- **Tailwind CSS 4**
- **Supabase** — auth, Postgres, storage
- **Anthropic Claude API** — document extraction, issue detection, and letter drafting
- **pdfkit** — server-side PDF export for generated letters

## Getting Started

```bash
git clone https://github.com/your-org/overbilled.git
cd overbilled
npm install
```

Copy the environment template and fill in your values:

```bash
cp .env.local.example .env.local
```

Apply the database schema in the Supabase SQL editor:

```bash
# paste contents of supabase/schema.sql into the Supabase dashboard SQL editor
# then apply migrations under supabase/migrations/ (fee schedule tables, etc.)
# or use the Supabase CLI:
supabase db push
```

Create a public Storage bucket named **`uploads`** in Supabase (used for bill/denial file uploads) with policies aligned to your RLS expectations.

Optional — load Medicare fee-schedule reference data (needed for locality-based rate enrichment in analysis):

```bash
npx tsx scripts/seed-fee-schedule.ts
```

Run the dev server:

```bash
npm run dev
```

Sign in and use **`/dashboard`** for the main flow (upload → analysis → letter → copy/PDF). The app root **`/`** is still the default Next.js placeholder page.

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Supabase dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only; fee-schedule lookups, scripts) | Supabase dashboard → Project Settings → API |
| `ANTHROPIC_API_KEY` | Anthropic API key | [console.anthropic.com](https://console.anthropic.com) → API Keys |

## Project Structure

```
src/
  middleware.ts           # Supabase session refresh; protects /dashboard, /upload, etc.
  lib/
    analyze.ts              # Claude extraction + JSON → AnalysisResult; fee-schedule enrichment
    generate-letter.ts      # Claude dispute/appeal letter from analysis payload
    fee-schedule.ts         # Medicare rate lookup (uses service role against Supabase)
    anthropic.ts            # Anthropic client singleton
    supabase/
      client.ts             # Browser Supabase client (anon key)
      server.ts             # Server Supabase client — anon key + cookies (user session / RLS)
  app/
    dashboard/page.tsx      # Primary UI: upload, analysis, history tabs
    (auth)/                 # login / signup
    auth/callback/route.ts  # Supabase auth callback
    api/
      analyze/route.ts      # POST — upload file, run analysis, persist document + analysis
      generate-letter/route.ts
      letter/[id]/pdf/route.ts
    upload/, analysis/[id]/, letter/[id]/   # Additional routes (deep links / legacy flow)

supabase/
  schema.sql                # Core tables: users, documents, analyses, letters + RLS
  migrations/               # e.g. fee_schedule, gpci, locality_county

scripts/
  seed-fee-schedule.ts      # Load CSV fee data into Supabase
  test-*.ts                 # Manual / integration checks against local API and DB

docs/
  specs/                    # Feature specs and API test plans
```

### Database Tables

| Table | Description |
|---|---|
| `users` | Extends Supabase auth; stores profile data |
| `documents` | Uploaded file metadata; status (`uploaded` → `processing` → `analyzed` or `error`) |
| `analyses` | Extraction output: `extracted_data` (JSONB), `issues` (JSONB), `summary` |
| `letters` | Generated dispute letters tied to a document and analysis |
| `fee_schedule`, `gpci`, `locality_county` | Reference data for Medicare rate lookups (see migrations) |

### Supported File Types

`application/pdf`, `image/jpeg`, `image/png`, `image/webp` — max 10 MB.
