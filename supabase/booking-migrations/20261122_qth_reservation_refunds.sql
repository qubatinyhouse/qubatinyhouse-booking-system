-- QTH booking database: partial and full reservation refund ledger.
-- Apply to the BOOKING Supabase project before using the refund control.
create table if not exists public.reservation_refunds (
 id uuid primary key default gen_random_uuid(),
 reservation_id uuid not null references public.reservations(id) on delete restrict,
 amount numeric(12,2) not null check(amount>0),
 payment_method text not null check(payment_method in ('cash','card')),
 refund_date date not null default current_date,
 reason text not null check(length(trim(reason)) between 1 and 500),
 admin_id uuid,
 request_key uuid not null unique,
 created_at timestamptz not null default now()
);
create index if not exists reservation_refunds_reservation_date_idx
 on public.reservation_refunds(reservation_id,refund_date desc);
alter table public.reservation_refunds enable row level security;
revoke all on public.reservation_refunds from anon,authenticated;
grant all on public.reservation_refunds to service_role;

create or replace function public.qth_admin_record_reservation_refund(
 p_reservation_id uuid,p_amount numeric,p_payment_method text,p_refund_date date,
 p_reason text,p_admin_id uuid,p_request_key uuid
) returns table(refund_id uuid,paid_amount numeric,remaining_amount numeric,refunded_amount numeric)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_res public.reservations%rowtype; v_refund_id uuid; v_refunded numeric;
begin
 if p_reservation_id is null or p_amount is null or p_amount<=0
   or p_payment_method not in ('cash','card') or p_refund_date is null
   or length(trim(coalesce(p_reason,''))) not between 1 and 500 or p_request_key is null
 then raise exception 'INVALID_REFUND_INPUT'; end if;
 select * into v_res from public.reservations where id=p_reservation_id for update;
 if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
 select id into v_refund_id from public.reservation_refunds where request_key=p_request_key;
 if found then
   select coalesce(sum(amount),0) into v_refunded from public.reservation_refunds where reservation_id=p_reservation_id;
   return query select v_refund_id,v_res.paid_amount,v_res.remaining_amount,v_refunded; return;
 end if;
 if p_amount>coalesce(v_res.paid_amount,0) then raise exception 'REFUND_EXCEEDS_PAID_AMOUNT'; end if;
 insert into public.reservation_refunds(reservation_id,amount,payment_method,refund_date,reason,admin_id,request_key)
 values(p_reservation_id,round(p_amount,2),p_payment_method,p_refund_date,trim(p_reason),p_admin_id,p_request_key)
 returning id into v_refund_id;
 update public.reservations
 set paid_amount=round(greatest(0,coalesce(paid_amount,0)-p_amount),2),
     remaining_amount=round(greatest(0,coalesce(total_amount,0)-greatest(0,coalesce(paid_amount,0)-p_amount)),2)
 where id=p_reservation_id returning * into v_res;
 select coalesce(sum(amount),0) into v_refunded from public.reservation_refunds where reservation_id=p_reservation_id;
 return query select v_refund_id,v_res.paid_amount,v_res.remaining_amount,v_refunded;
end $$;
revoke all on function public.qth_admin_record_reservation_refund(uuid,numeric,text,date,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.qth_admin_record_reservation_refund(uuid,numeric,text,date,text,uuid,uuid) to service_role;
