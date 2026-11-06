-- Performance indexes for foreign-key lookups in the finance/admin database.
-- Safe additive migration; does not alter or delete business data.
create index if not exists booking_finance_sync_finance_transaction_id_idx
  on public.booking_finance_sync (finance_transaction_id);
create index if not exists booking_payment_finance_sync_finance_transaction_id_idx
  on public.booking_payment_finance_sync (finance_transaction_id);
create index if not exists booking_payment_finance_sync_owner_id_idx
  on public.booking_payment_finance_sync (owner_id);
create index if not exists cleaning_tasks_employee_id_idx
  on public.cleaning_tasks (employee_id);
create index if not exists reservations_customer_id_idx
  on public.reservations (customer_id);
create index if not exists utility_payments_utility_id_idx
  on public.utility_payments (utility_id);
