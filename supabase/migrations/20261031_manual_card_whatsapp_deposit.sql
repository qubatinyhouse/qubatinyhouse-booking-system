-- Manual 50% card-transfer + WhatsApp receipt workflow.
-- Safe to run on an existing database; keeps all reservation and finance rows.
alter table public.reservations
  drop constraint if exists reservations_deposit_percent_check;

alter table public.reservations
  add constraint reservations_deposit_percent_check
  check (deposit_percent in (30, 40, 50));

-- Give guests enough time to make a manual bank transfer and send the receipt.
create or replace function public.create_booking_atomic(
  p_unit_id text,
  p_check_in date,
  p_check_out date,
  p_guest_name text,
  p_phone text,
  p_guest_count integer,
  p_breakfast boolean,
  p_note text,
  p_stay_amount numeric,
  p_breakfast_amount numeric,
  p_total_amount numeric,
  p_deposit_percent integer,
  p_deposit_amount numeric,
  p_remaining_amount numeric
)
returns table(id uuid, booking_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.units%rowtype;
  new_id uuid;
  new_code text;
  new_expiry timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_unit_id));
  update public.reservations
     set status = 'expired'
   where unit_id = p_unit_id and status = 'pending_payment' and expires_at <= now();

  select * into u from public.units where units.id = p_unit_id and active = true for update;
  if not found then raise exception 'UNIT_NOT_FOUND'; end if;
  if u.is_demo_rate then raise exception 'RATES_NOT_CONFIGURED'; end if;
  if p_guest_count > u.capacity then raise exception 'GUEST_CAPACITY_EXCEEDED'; end if;
  if p_check_out <= p_check_in then raise exception 'INVALID_DATES'; end if;
  if exists (
    select 1 from public.reservations r
     where r.unit_id = p_unit_id
       and r.status in ('pending_payment','confirmed')
       and r.check_in < p_check_out and r.check_out > p_check_in
       and (r.status = 'confirmed' or r.expires_at > now())
  ) then raise exception 'DATES_ALREADY_BOOKED'; end if;

  insert into public.reservations (
    unit_id,check_in,check_out,guest_name,phone,guest_count,breakfast,note,
    stay_amount,breakfast_amount,total_amount,deposit_percent,deposit_amount,remaining_amount,status,payment_status,expires_at
  ) values (
    p_unit_id,p_check_in,p_check_out,left(trim(p_guest_name),120),left(trim(p_phone),30),p_guest_count,coalesce(p_breakfast,false),left(coalesce(p_note,''),1500),
    p_stay_amount,p_breakfast_amount,p_total_amount,p_deposit_percent,p_deposit_amount,p_remaining_amount,'pending_payment','created',now()+interval '60 minutes'
  ) returning reservations.id, reservations.booking_code, reservations.expires_at into new_id,new_code,new_expiry;
  return query select new_id,new_code,new_expiry;
end;
$$;

revoke all on function public.create_booking_atomic(text,date,date,text,text,integer,boolean,text,numeric,numeric,numeric,integer,numeric,numeric) from public, anon, authenticated;
grant execute on function public.create_booking_atomic(text,date,date,text,text,integer,boolean,text,numeric,numeric,numeric,integer,numeric,numeric) to service_role;
