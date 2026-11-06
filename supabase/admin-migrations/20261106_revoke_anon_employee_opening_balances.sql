-- Payroll opening balances must never be readable by anonymous API clients.
revoke all privileges on table public.employee_opening_balances from anon;
