alter table public.salary_payments
  add column if not exists request_key uuid,
  add column if not exists finance_transaction_id uuid;

update public.salary_payments
set request_key = gen_random_uuid()
where request_key is null;

alter table public.salary_payments
  alter column request_key set default gen_random_uuid(),
  alter column request_key set not null;

create unique index if not exists salary_payments_request_key_uidx
  on public.salary_payments(request_key);

create unique index if not exists salary_payments_finance_transaction_uidx
  on public.salary_payments(finance_transaction_id)
  where finance_transaction_id is not null;

drop function if exists public.pay_employee_salary(uuid,numeric,date,text,date,date,text);

create or replace function public.pay_employee_salary(
  p_employee_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_period_start date,
  p_period_end date,
  p_notes text default '',
  p_request_key uuid default gen_random_uuid()
)
returns uuid
language plpgsql
set search_path = public, auth
as $function$
declare
  v_payment_id uuid;
  v_finance_id uuid;
  v_employee_name text;
  v_existing public.salary_payments%rowtype;
begin
  if auth.uid() is null
     or (auth.jwt()->>'aal') <> 'aal2'
     or (auth.jwt()->'app_metadata'->>'role') <> 'admin' then
    raise exception 'İcazəsiz əməliyyat: admin MFA tələb olunur';
  end if;

  if p_employee_id is null
     or p_amount is null or p_amount <= 0
     or p_payment_date is null
     or p_payment_method not in ('cash','bank','card')
     or p_period_start is null or p_period_end is null
     or p_period_start > p_period_end
     or p_request_key is null then
    raise exception 'Maaş ödənişi məlumatları düzgün deyil';
  end if;

  select full_name into v_employee_name
  from public.employees
  where id=p_employee_id and active=true
  for update;

  if not found then
    raise exception 'Aktiv işçi tapılmadı';
  end if;

  insert into public.salary_payments(
    employee_id,amount,payment_date,period_start,period_end,
    payment_method,notes,request_key
  )
  values(
    p_employee_id,p_amount,p_payment_date,p_period_start,p_period_end,
    p_payment_method,nullif(trim(coalesce(p_notes,'')),''),p_request_key
  )
  on conflict(request_key) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    select * into v_existing from public.salary_payments
    where request_key=p_request_key;
    if not found then
      raise exception 'Ödəniş sorğusu tapılmadı';
    end if;
    if v_existing.employee_id<>p_employee_id
       or v_existing.amount<>p_amount
       or v_existing.payment_date<>p_payment_date
       or v_existing.period_start<>p_period_start
       or v_existing.period_end<>p_period_end
       or coalesce(v_existing.payment_method,'')<>p_payment_method then
      raise exception 'Eyni sorğu açarı fərqli ödəniş məlumatları ilə istifadə olunub';
    end if;
    return v_existing.id;
  end if;

  insert into public.finance_transactions(
    transaction_type,category,amount,payment_method,description,transaction_date
  )
  values(
    'expense','Maaş',p_amount,p_payment_method,
    v_employee_name || ' - maaş ödənişi',p_payment_date
  )
  returning id into v_finance_id;

  update public.salary_payments
  set finance_transaction_id=v_finance_id
  where id=v_payment_id;

  return v_payment_id;
end;
$function$;

revoke all on function public.pay_employee_salary(uuid,numeric,date,text,date,date,text,uuid) from public,anon;
grant execute on function public.pay_employee_salary(uuid,numeric,date,text,date,date,text,uuid) to authenticated;
notify pgrst,'reload schema';