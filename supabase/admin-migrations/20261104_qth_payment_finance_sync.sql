-- ADMIN / FINANCE DATABASE ONLY.
-- Apply to the separate Supabase project used by public/finance.html.
-- Existing finance_transactions and booking_finance_sync rows are retained.

alter function public.record_booking_deposit_income(uuid,numeric,text,text,date)
  security invoker;
revoke all on function public.record_booking_deposit_income(uuid,numeric,text,text,date)
  from public, anon;
grant execute on function public.record_booking_deposit_income(uuid,numeric,text,text,date)
  to authenticated;

create table if not exists public.booking_payment_finance_sync (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reservation_payment_id uuid not null unique,
  reservation_id uuid not null,
  finance_transaction_id uuid not null references public.finance_transactions(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash','bank','card','transfer')),
  created_at timestamptz not null default now()
);

alter table public.booking_payment_finance_sync enable row level security;
drop policy if exists "Owner manages booking payment finance sync" on public.booking_payment_finance_sync;
create policy "Owner manages booking payment finance sync"
  on public.booking_payment_finance_sync
  for all
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
grant select, insert, update, delete on public.booking_payment_finance_sync to authenticated;

create or replace function public.record_booking_payment_income(
  p_payment_id uuid,
  p_reservation_id uuid,
  p_amount numeric,
  p_payment_type text,
  p_payment_method text,
  p_description text,
  p_transaction_date date default current_date
)
returns table(result_status text, transaction_id uuid)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_owner uuid := auth.uid();
  v_transaction_id uuid;
  v_legacy_transaction_id uuid;
  v_category text;
begin
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  if p_payment_id is null or p_reservation_id is null or p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_BOOKING_PAYMENT';
  end if;
  if p_payment_type not in ('deposit','remaining','other') then
    raise exception 'INVALID_PAYMENT_TYPE';
  end if;
  if p_payment_method not in ('cash','bank','card','transfer') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  select s.finance_transaction_id
    into v_transaction_id
    from public.booking_payment_finance_sync s
   where s.reservation_payment_id = p_payment_id
     and s.owner_id = v_owner;
  if found then
    return query select 'already_recorded'::text, v_transaction_id;
    return;
  end if;

  v_category := case
    when p_payment_type = 'deposit' then 'Rezervasiya behi'
    when p_payment_type = 'remaining' then 'Rezervasiya qalıq ödənişi'
    else 'Rezervasiya ödənişi'
  end;

  -- Only a backfilled deposit may reuse the legacy reservation-level finance row.
  -- Remaining/other payments must always create a separate transaction.
  if p_payment_type = 'deposit'
     and not exists (
       select 1 from public.booking_payment_finance_sync s
        where s.reservation_id = p_reservation_id
          and s.owner_id = v_owner
     ) then
    select s.finance_transaction_id
      into v_legacy_transaction_id
      from public.booking_finance_sync s
     where s.reservation_id = p_reservation_id
       and s.owner_id = v_owner
     limit 1;

    if v_legacy_transaction_id is not null then
      update public.finance_transactions
         set amount = round(p_amount,2),
             category = v_category,
             payment_method = p_payment_method,
             description = left(coalesce(p_description,'Rezervasiya ödənişi'),500),
             transaction_date = coalesce(p_transaction_date,current_date)
       where id = v_legacy_transaction_id
         and owner_id = v_owner;
      if found then
        insert into public.booking_payment_finance_sync
          (owner_id,reservation_payment_id,reservation_id,finance_transaction_id,amount,payment_method)
        values
          (v_owner,p_payment_id,p_reservation_id,v_legacy_transaction_id,round(p_amount,2),p_payment_method);
        return query select 'linked_existing'::text, v_legacy_transaction_id;
        return;
      end if;
    end if;
  end if;

  insert into public.finance_transactions
    (owner_id,transaction_type,category,amount,payment_method,description,transaction_date)
  values
    (v_owner,'income',v_category,round(p_amount,2),p_payment_method,
     left(coalesce(p_description,'Rezervasiya ödənişi'),500),
     coalesce(p_transaction_date,current_date))
  returning id into v_transaction_id;

  insert into public.booking_payment_finance_sync
    (owner_id,reservation_payment_id,reservation_id,finance_transaction_id,amount,payment_method)
  values
    (v_owner,p_payment_id,p_reservation_id,v_transaction_id,round(p_amount,2),p_payment_method);

  return query select 'recorded'::text, v_transaction_id;
end;
$function$;

revoke all on function public.record_booking_payment_income(uuid,uuid,numeric,text,text,text,date)
  from public, anon;
grant execute on function public.record_booking_payment_income(uuid,uuid,numeric,text,text,text,date)
  to authenticated;

-- In production the existing admin user's app_metadata.role is set to 'admin'
-- through a trusted Supabase admin operation. Never promote every authenticated user.
