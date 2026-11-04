-- Admin-only manual pricing for reservations created by the manager.
-- Public website bookings continue to use create_booking_atomic and public tariffs.
create or replace function public.create_admin_booking_atomic(
  p_unit_id text,
  p_check_in date,
  p_check_out date,
  p_guest_name text,
  p_phone text,
  p_guest_count integer,
  p_note text,
  p_total_amount numeric,
  p_paid_amount numeric
)
returns table(id uuid, booking_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  u public.units%rowtype;
  new_id uuid;
  new_code text;
  new_expiry timestamptz;
  v_deposit numeric(10,2);
begin
  if p_total_amount is null or p_total_amount < 50
     or p_paid_amount is null or p_paid_amount < 0
     or p_paid_amount > p_total_amount then
    raise exception 'INVALID_ADMIN_BOOKING_AMOUNT';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in
     or p_check_out - p_check_in > 30 then
    raise exception 'INVALID_DATES';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_unit_id));

  select * into u
    from public.units as units
   where units.id = p_unit_id and units.active = true
   for update;
  if not found then raise exception 'UNIT_NOT_FOUND'; end if;
  if p_guest_count is null or p_guest_count < 1 or p_guest_count > u.capacity then
    raise exception 'GUEST_CAPACITY_EXCEEDED';
  end if;
  if length(trim(coalesce(p_guest_name,''))) < 2
     or length(trim(coalesce(p_phone,''))) < 7 then
    raise exception 'INVALID_GUEST_DETAILS';
  end if;

  update public.reservations as r
     set status = 'expired'
   where r.unit_id = p_unit_id
     and r.status = 'pending_payment'
     and r.expires_at <= now();

  if exists (
    select 1 from public.reservations as r
     where r.unit_id = p_unit_id
       and r.status in ('pending_payment','confirmed')
       and r.check_in < p_check_out and r.check_out > p_check_in
       and (r.status = 'confirmed' or r.expires_at > now())
  ) then raise exception 'DATES_ALREADY_BOOKED'; end if;

  if exists (
    select 1 from public.blocked_dates as d
     where d.unit_id = p_unit_id and d.active = true
       and d.check_in < p_check_out and d.check_out > p_check_in
  ) then raise exception 'DATES_BLOCKED_BY_ADMIN'; end if;

  -- If an advance is entered, that exact amount is the confirmation threshold.
  -- If no advance is received yet, keep a 50 AZN minimum advance threshold.
  v_deposit := case when p_paid_amount > 0 then p_paid_amount else least(50, p_total_amount) end;

  insert into public.reservations (
    unit_id,check_in,check_out,guest_name,phone,guest_count,breakfast,note,
    stay_amount,breakfast_amount,total_amount,deposit_percent,deposit_amount,
    remaining_amount,status,payment_status,expires_at
  ) values (
    p_unit_id,p_check_in,p_check_out,left(trim(p_guest_name),120),left(trim(p_phone),30),
    p_guest_count,false,left(coalesce(p_note,''),1500),
    p_total_amount,0,p_total_amount,50,v_deposit,
    round(p_total_amount-p_paid_amount,2),
    'pending_payment','created',now()+interval '25 minutes'
  )
  returning reservations.id,reservations.booking_code,reservations.expires_at
  into new_id,new_code,new_expiry;

  return query select new_id,new_code,new_expiry;
end;
$function$;

revoke all on function public.create_admin_booking_atomic(text,date,date,text,text,integer,text,numeric,numeric)
  from public, anon, authenticated;
grant execute on function public.create_admin_booking_atomic(text,date,date,text,text,integer,text,numeric,numeric)
  to service_role;
