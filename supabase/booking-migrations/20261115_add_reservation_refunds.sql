create table if not exists public.reservation_refunds (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  amount numeric not null check (amount > 0),
  refund_method text not null check (refund_method in ('card','bank','cash','transfer')),
  refund_date date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists reservation_refunds_reservation_id_idx
  on public.reservation_refunds(reservation_id);
alter table public.reservation_refunds enable row level security;
