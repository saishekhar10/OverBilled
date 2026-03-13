create extension if not exists "pgcrypto";

-- Users (extends Supabase auth)
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamp default now()
);
alter table users enable row level security;
create policy "users can only access own profile"
  on users for all using (auth.uid() = id);

-- Documents
create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  type text check (type in ('medical_bill', 'denial_letter')),
  file_path text,
  file_name text,
  status text default 'uploaded'
    check (status in ('uploaded', 'processing', 'analyzed', 'error')),
  created_at timestamp default now(),
  updated_at timestamp default now()
);
alter table documents enable row level security;
create policy "users can only access own documents"
  on documents for all using (auth.uid() = user_id);

-- Auto-update updated_at on documents
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger documents_updated_at
  before update on documents
  for each row execute function update_updated_at();

-- Analyses
create table analyses (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  extracted_data jsonb,
  issues jsonb,
  summary text,
  created_at timestamp default now()
);
alter table analyses enable row level security;
create policy "users can only access own analyses"
  on analyses for all using (
    document_id in (
      select id from documents where user_id = auth.uid()
    )
  );

-- Letters
create table letters (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  analysis_id uuid references analyses(id),
  recipient text check (recipient in ('hospital', 'insurer')),
  content text,
  file_path text,
  created_at timestamp default now()
);
alter table letters enable row level security;
create policy "users can only access own letters"
  on letters for all using (
    document_id in (
      select id from documents where user_id = auth.uid()
    )
  );
