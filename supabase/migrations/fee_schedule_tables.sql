-- Fee schedule: one row per CPT code (and modifier combination)
create table if not exists fee_schedule (
  id             serial primary key,
  hcpcs_code     text not null,
  modifier       text not null default '',
  description    text,
  status_code    text,
  work_rvu       numeric(8,2),
  non_fac_pe_rvu numeric(8,2),
  fac_pe_rvu     numeric(8,2),
  mp_rvu         numeric(6,4),
  non_fac_total  numeric(8,2),
  fac_total      numeric(8,2),
  conv_factor    numeric(10,4),
  created_at     timestamp default now()
);

create unique index if not exists fee_schedule_code_mod_idx
  on fee_schedule (hcpcs_code, modifier);

create index if not exists fee_schedule_hcpcs_idx
  on fee_schedule (hcpcs_code);

-- Geographic Practice Cost Indices: one row per locality
create table if not exists gpci (
  id              serial primary key,
  mac             text,
  state           text not null,
  locality_number text not null,
  locality_name   text,
  work_gpci       numeric(6,3),
  pe_gpci         numeric(6,3),
  mp_gpci         numeric(6,3),
  created_at      timestamp default now()
);

create unique index if not exists gpci_state_locality_idx
  on gpci (state, locality_number);

create index if not exists gpci_state_idx
  on gpci (state);

-- Locality/county crosswalk: maps state + county to locality number
create table if not exists locality_county (
  id              serial primary key,
  mac             text,
  locality_number text not null,
  state           text not null,
  locality_name   text,
  counties        text,
  is_statewide    boolean default false,
  created_at      timestamp default now()
);

create index if not exists locality_county_state_idx
  on locality_county (state);

create unique index if not exists locality_county_state_locality_idx
  on locality_county (state, locality_number);
