-- BOOKING DATABASE ONLY: Quba Tiny House payment ledger and safe confirmation.
-- Applied to production project on 2026-11-04.
-- This migration preserves reservations and backfills each existing paid_amount as one historic ledger row.

create table if not exists public.reservation_payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  payment_type text not null check (payment_type in ('deposit','remaining','other')),
  payment_method text check (payment_method is null or payment_method in ('cash','bank','card','transfer')),
  payment_date date not null default current_date,
  notes text not null default '',
  request_key uuid,
  transaction_reference text,
  created_at timestamptz not null default now()
);

create index if not exists reservation_payments_reservation_date_idx
  on public.reservation_payments (reservation_id, payment_date desc, created_at desc);
create unique index if not exists reservation_payments_request_key_idx
  on public.reservation_payments (request_key) where request_key is not null;
create unique index if not exists reservation_payments_transaction_reference_idx
  on public.reservation_payments (transaction_reference) where transaction_reference is not null;

alter table public.reservation_payments enable row level security;
revoke all on public.reservation_payments from public, anon, authenticated;
grant select, insert, update, delete on public.reservation_payments to service_role;

insert into public.reservation_payments
  (reservation_id, amount, payment_type, payment_method, payment_date, notes)
select
  r.id,
  r.paid_amount,
  case when r.paid_amount <= r.deposit_amount then 'deposit' else 'other' end,
  null,
  coalesce(r.paid_at::date, r.created_at::date, current_date),
  'Tarixçədən bərpa edildi: əvvəlki sistemdə yalnız ümumi ödənilmiş məbləğ saxlanılırdı; ödəniş üsulu ayrıca qeydə alınmamışdı.'
from public.reservations r
where coalesce(r.paid_amount, 0) > 0
  and not exists (
    select 1 from public.reservation_payments p where p.reservation_id = r.id
  );

create or replace function public.record_reservation_payment(
  p_reservation_id uuid,
  p_amount numeric,
  p_payment_type text,
  p_payment_method text,
  p_payment_date date default current_date,
  p_notes text default '',
  p_request_key uuid default null,
  p_transaction_reference text default null
)
returns table(
  payment_id uuid,
  result_status text,
  reservation_status text,
  paid_amount numeric,
  remaining_amount numeric
)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  b public.reservations%rowtype;
  existing_payment public.reservation_payments%rowtype;
  v_paid numeric(12,2);
  v_new_paid numeric(12,2);
  v_has_conflict boolean := false;
  v_new_status text;
  v_payment_id uuid;
begin
  if p_reservation_id is null or p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_BOOKING_PAYMENT';
  end if;
  if p_payment_type not in ('deposit','remaining','other') then
    raise exception 'INVALID_PAYMENT_TYPE';
  end if;
  if p_payment_method not in ('cash','bank','card','transfer') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  select * into b
    from public.reservations
   where id = p_reservation_id
   for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if p_request_key is not null then
    select * into existing_payment
      from public.reservation_payments
     where request_key = p_request_key
     limit 1;
    if found then
      if existing_payment.reservation_id <> p_reservation_id then
        raise exception 'PAYMENT_REQUEST_KEY_ALREADY_USED';
      end if;
      return query
        select existing_payment.id, 'already_recorded'::text, b.status,
               coalesce(b.paid_amount,0), greatest(0,round(b.total_amount-coalesce(b.paid_amount,0),2));
      return;
    end if;
  end if;

  if p_transaction_reference is not null then
    select * into existing_payment
      from public.reservation_payments
     where transaction_reference = p_transaction_reference
     limit 1;
    if found then
      if existing_payment.reservation_id <> p_reservation_id then
        raise exception 'PAYMENT_REFERENCE_ALREADY_USED';
      end if;
      return query
        select existing_payment.id, 'already_recorded'::text, b.status,
               coalesce(b.paid_amount,0), greatest(0,round(b.total_amount-coalesce(b.paid_amount,0),2));
      return;
    end if;
  end if;

  if b.status in ('cancelled','payment_failed','payment_review') then
    raise exception 'BOOKING_NOT_ELIGIBLE_FOR_PAYMENT';
  end if;

  v_paid := coalesce(b.paid_amount,0);
  if p_payment_type = 'remaining' and v_paid < b.deposit_amount then
    raise exception 'DEPOSIT_NOT_SETTLED';
  end if;
  v_new_paid := round(v_paid + p_amount, 2);
  if v_new_paid > b.total_amount then
    raise exception 'PAYMENT_EXCEEDS_REMAINING_BALANCE';
  end if;

  insert into public.reservation_payments
    (reservation_id,amount,payment_type,payment_method,payment_date,notes,request_key,transaction_reference)
  values
    (p_reservation_id,round(p_amount,2),p_payment_type,p_payment_method,
     coalesce(p_payment_date,current_date),left(coalesce(p_notes,''),500),
     p_request_key,nullif(trim(coalesce(p_transaction_reference,'')), ''))
  returning id into v_payment_id;

  select exists (
    select 1
      from public.reservations r
     where r.id <> b.id
       and r.unit_id = b.unit_id
       and r.status in ('pending_payment','confirmed')
       and r.check_in < b.check_out
       and r.check_out > b.check_in
       and (r.status = 'confirmed' or r.expires_at > now())
  ) or exists (
    select 1
      from public.blocked_dates d
     where d.unit_id = b.unit_id
       and d.active = true
       and d.check_in < b.check_out
       and d.check_out > b.check_in
  ) into v_has_conflict;

  if v_new_paid >= b.deposit_amount then
    v_new_status := case when v_has_conflict then 'payment_review' else 'confirmed' end;
  elsif b.status = 'expired' then
    v_new_status := 'payment_review';
  else
    v_new_status := 'pending_payment';
  end if;

  update public.reservations
     set paid_amount = v_new_paid,
         remaining_amount = greatest(0,round(total_amount-v_new_paid,2)),
         paid_at = now(),
         status = v_new_status,
         payment_status = case
           when v_new_status = 'payment_review' then 'paid_but_schedule_conflict'
           when v_new_paid >= total_amount then 'paid_full'
           when v_new_paid >= deposit_amount then 'deposit_paid'
           else 'partial_deposit'
         end,
         payment_transaction = coalesce(nullif(trim(coalesce(p_transaction_reference,'')), ''), payment_transaction)
   where id = p_reservation_id;

  return query
    select v_payment_id,
           case when v_new_status = 'payment_review' then 'payment_review' else 'recorded' end,
           v_new_status,
           v_new_paid,
           greatest(0,round(b.total_amount-v_new_paid,2));
end;
$function$;

revoke all on function public.record_reservation_payment(uuid,numeric,text,text,date,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.record_reservation_payment(uuid,numeric,text,text,date,text,uuid,text)
  to service_role;

create or replace function public.confirm_manual_paid_booking(
  p_reservation_id uuid,
  p_paid_amount numeric,
  p_payment_method text
)
returns table(result_status text)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  result_row record;
begin
  select * into result_row
    from public.record_reservation_payment(
      p_reservation_id, p_paid_amount, 'deposit', p_payment_method,
      current_date, 'Admin panel manual payment', null, null
    );
  return query select result_row.result_status;
end;
$function$;

revoke all on function public.confirm_manual_paid_booking(uuid,numeric,text)
  from public, anon, authenticated;
grant execute on function public.confirm_manual_paid_booking(uuid,numeric,text)
  to service_role;
revoke all on function public.confirm_manual_paid_booking(uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_manual_paid_booking(uuid)
  to service_role;

create or replace function public.confirm_paid_booking_atomic(
  p_booking_code text,
  p_transaction text,
  p_paid_amount numeric
)
returns table(result_status text)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  b public.reservations%rowtype;
  result_row record;
begin
  select * into b from public.reservations where booking_code = p_booking_code;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  select * into result_row
    from public.record_reservation_payment(
      b.id, p_paid_amount, 'deposit', 'card', current_date,
      'Epoint onlayn ödənişi', null, p_transaction
    );
  return query select case
    when result_row.result_status = 'payment_review' then 'payment_review'::text
    else 'confirmed'::text
  end;
end;
$function$;

revoke all on function public.confirm_paid_booking_atomic(text,text,numeric)
  from public, anon, authenticated;
grant execute on function public.confirm_paid_booking_atomic(text,text,numeric)
  to service_role;

revoke all on function public.issue_honeymoon_coupon()
  from public, anon, authenticated;
grant execute on function public.issue_honeymoon_coupon()
  to service_role;
