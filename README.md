# OverBilled

Upload a medical bill or denial letter and get a dispute letter ready to send in minutes.

## Tech Stack

- **Next.js 15** (App Router) + **TypeScript**
- **Tailwind CSS**
- **Supabase** — auth, Postgres, storage
- **Anthropic Claude API** — document extraction and analysis

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
# or use the Supabase CLI:
supabase db push
```

Run the dev server:

```bash
npm run dev
```

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Supabase dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) | Supabase dashboard → Project Settings → API |
| `ANTHROPIC_API_KEY` | Anthropic API key | console.anthropic.com → API Keys |

## Project Structure

```
src/
  lib/
    analyze.ts              # Core extraction logic — calls Claude with a structured
                            # prompt, parses the JSON response into AnalysisResult
    anthropic.ts            # Anthropic client singleton
    supabase/
      client.ts             # Browser Supabase client
      server.ts             # Server-side Supabase client (uses service role)
  app/
    api/
      analyze/
        route.ts            # POST /api/analyze — validates auth, uploads file to
                            # Supabase Storage, runs Claude extraction, writes
                            # documents + analyses rows, returns structured result

supabase/
  schema.sql                # Full Postgres schema: users, documents, analyses,
                            # letters tables with RLS policies

docs/
  specs/                    # Feature specs and API test plans
```

### Database Tables

| Table | Description |
|---|---|
| `users` | Extends Supabase auth; stores profile data |
| `documents` | Uploaded file metadata, status (`uploaded → processing → analyzed`) |
| `analyses` | Claude extraction output: `extracted_data` (JSONB), `issues` (JSONB), `summary` |
| `letters` | Generated dispute letters tied to a document and analysis |

### Supported File Types

`application/pdf`, `image/jpeg`, `image/png`, `image/webp` — max 10 MB.
