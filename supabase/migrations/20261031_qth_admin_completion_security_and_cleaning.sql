-- QTH finance hardening and cleaning task module.
-- Existing finance records are retained; no tables or rows are dropped.
create table if not exists public.cleaning_tasks (
  id uuid primary key default gen_random_uuid(),
  house_type text not null check (house_type in ('scandinav', 'aframe')),
  house_name text,
  task_date date not null,
  employee_id uuid references public.employees(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','completed')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  notes text,
  owner_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.cleaning_tasks enable row level security;
drop policy if exists "owner manages cleaning tasks" on public.cleaning_tasks;
create policy "owner manages cleaning tasks" on public.cleaning_tasks
for all to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "authenticated customers access" on public.customers;
drop policy if exists "authenticated users can manage customers" on public.customers;
create policy "owner only customers" on public.customers for all to authenticated
using ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid)
with check ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid);

drop policy if exists "authenticated houses access" on public.houses;
drop policy if exists "authenticated users can manage houses" on public.houses;
create policy "owner only houses" on public.houses for all to authenticated
using ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid)
with check ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid);

drop policy if exists "authenticated reservations access" on public.reservations;
drop policy if exists "authenticated users can manage reservations" on public.reservations;
create policy "owner only reservations" on public.reservations for all to authenticated
using ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid)
with check ((select auth.uid()) = '8c335f94-d870-4b76-a5cc-638126607be8'::uuid);

revoke all on function public.create_reservation(uuid,uuid,text,text,date,date,integer,integer,numeric,numeric,text,text,text) from public, anon, authenticated;
grant execute on function public.create_reservation(uuid,uuid,text,text,date,date,integer,integer,numeric,numeric,text,text,text) to service_role;
revoke all on function public.pay_employee_salary(uuid,numeric,date,text,date,date,text) from public, anon;
grant execute on function public.pay_employee_salary(uuid,numeric,date,text,date,date,text) to authenticated, service_role;
revoke all on function public.record_utility_payment(uuid,numeric,text,text) from public, anon;
grant execute on function public.record_utility_payment(uuid,numeric,text,text) to authenticated, service_role;
