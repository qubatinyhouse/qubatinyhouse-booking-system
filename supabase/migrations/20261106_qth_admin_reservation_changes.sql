-- QTH admin reservation changes and early checkout.
-- Apply to the booking Supabase project before enabling the admin UI.
create table if not exists public.reservation_change_audit (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  admin_id uuid,
  change_mode text not null check (change_mode in ('modify','early_checkout')),
  reason text not null default '',
  old_data jsonb not null,
  new_data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists reservation_change_audit_reservation_idx
  on public.reservation_change_audit(reservation_id, created_at desc);
alter table public.reservation_change_audit enable row level security;
revoke all on public.reservation_change_audit from anon, authenticated;

create or replace function public.qth_admin_update_reservation(
  p_reservation_id uuid,
  p_admin_id uuid,
  p_unit_id text,
  p_check_in date,
  p_check_out date,
  p_guest_count integer,
  p_total_amount numeric,
  p_change_mode text,
  p_reason text default ''
)
returns setof public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_old public.reservations%rowtype;
  v_unit public.units%rowtype;
  v_new public.reservations%rowtype;
begin
  if p_change_mode not in ('modify','early_checkout') then
    raise exception 'INVALID_CHANGE_MODE';
  end if;
  if p_check_out <= p_check_in or p_check_out - p_check_in > 30 then
    raise exception 'INVALID_STAY_DATES';
  end if;

  select * into v_old
    from public.reservations
   where id = p_reservation_id
   for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_old.status not in ('confirmed','pending_payment','payment_review') then
    raise exception 'RESERVATION_NOT_ACTIVE';
  end if;
  if p_change_mode = 'early_checkout' and p_check_out >= v_old.check_out then
    raise exception 'EARLY_CHECKOUT_DATE_REQUIRED';
  end if;
  if p_total_amount is null or p_total_amount < coalesce(v_old.paid_amount,0) then
    raise exception 'PAID_AMOUNT_EXCEEDS_TOTAL';
  end if;

  select * into v_unit from public.units
   where id = p_unit_id and active = true;
  if not found then raise exception 'UNIT_NOT_AVAILABLE'; end if;
  if p_guest_count < 1 or p_guest_count > v_unit.capacity then
    raise exception 'UNIT_CAPACITY';
  end if;

  if exists (
    select 1 from public.reservations r
     where r.unit_id = p_unit_id
       and r.id <> p_reservation_id
       and r.status in ('pending_payment','confirmed')
       and daterange(r.check_in,r.check_out,'[)') && daterange(p_check_in,p_check_out,'[)')
  ) then raise exception 'DATES_ALREADY_BOOKED'; end if;

  if exists (
    select 1 from public.blocked_dates b
     where b.unit_id = p_unit_id and b.active = true
       and b.check_in < p_check_out and b.check_out > p_check_in
  ) then raise exception 'BLOCKED_DATES'; end if;

  update public.reservations
     set unit_id = p_unit_id,
         check_in = p_check_in,
         check_out = p_check_out,
         guest_count = p_guest_count,
         stay_amount = round(p_total_amount,2),
         breakfast_amount = 0,
         total_amount = round(p_total_amount,2),
         deposit_amount = least(coalesce(deposit_amount,0),round(p_total_amount,2)),
         remaining_amount = round(p_total_amount - coalesce(paid_amount,0),2)
   where id = p_reservation_id
   returning * into v_new;

  insert into public.reservation_change_audit
    (reservation_id,admin_id,change_mode,reason,old_data,new_data)
  values
    (p_reservation_id,p_admin_id,p_change_mode,left(coalesce(p_reason,''),500),
     to_jsonb(v_old),to_jsonb(v_new));

  return next v_new;
end;
$function$;

revoke all on function public.qth_admin_update_reservation(uuid,uuid,text,date,date,integer,numeric,text,text)
  from public, anon, authenticated;
grant execute on function public.qth_admin_update_reservation(uuid,uuid,text,date,date,integer,numeric,text,text)
  to service_role;
