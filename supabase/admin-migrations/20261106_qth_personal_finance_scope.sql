alter table public.finance_transactions
  add column if not exists expense_scope text not null default 'business';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.finance_transactions'::regclass
      and conname='finance_transactions_expense_scope_check'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_expense_scope_check
      check (expense_scope in ('business','personal','owner_draw'));
  end if;
end $$;

create index if not exists finance_transactions_scope_date_idx
  on public.finance_transactions(expense_scope, transaction_date desc);

comment on column public.finance_transactions.expense_scope is
  'business = operating expense; personal = personal expense; owner_draw = owner withdrawal (cash movement, not P&L expense). Historical rows default to business.';
