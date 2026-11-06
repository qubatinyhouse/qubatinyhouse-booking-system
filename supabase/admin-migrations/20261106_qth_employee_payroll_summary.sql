-- Secure dashboard payroll summary.
-- Only authenticated admin sessions with verified TOTP (AAL2) can execute.
create or replace function public.qth_get_employee_payroll_summary(p_month text default to_char(current_date,'YYYY-MM'))
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $function$
declare
  v_month_start date;
  v_month_end date;
  v_result jsonb;
begin
  if auth.uid() is null
     or (auth.jwt()->>'aal') <> 'aal2'
     or (auth.jwt()->'app_metadata'->>'role') <> 'admin' then
    raise exception 'İcazəsiz əməliyyat: admin MFA tələb olunur';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'Ay formatı YYYY-MM olmalıdır';
  end if;
  v_month_start := (p_month || '-01')::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;

  with active_employees as (
    select e.id,e.full_name,e.position,e.salary_type,coalesce(e.base_salary,0)::numeric as base_salary,
      case
        when lower(coalesce(e.position,'') || ' ' || coalesce(e.full_name,'')) ~ '(təmizlik|temizlik|clean)' then 'Təmizlik işçisi'
        when lower(coalesce(e.position,'') || ' ' || coalesce(e.full_name,'')) ~ '(nəzarət|nezaret|supervisor)' then 'Nəzarətçi'
        else null
      end as role
    from public.employees e where e.active=true
  ),
  opening as (
    select o.employee_id,o.balance_month,
      greatest(0,o.amount-coalesce((
        select sum(sp.amount) from public.salary_payments sp
        where sp.employee_id=o.employee_id and sp.period_start is not null and sp.period_end is not null
          and sp.period_start <= (date_trunc('month',o.balance_month)::date + interval '1 month - 1 day')::date
          and sp.period_end >= date_trunc('month',o.balance_month)::date
      ),0)) as remaining
    from public.employee_opening_balances o where o.balance_month < v_month_start
  ),
  cleaning_due as (
    select t.id,t.employee_id,t.task_date,greatest(0,t.amount-coalesce(sum(cp.amount),0)) as remaining
    from public.cleaning_tasks t
    left join public.cleaning_task_payments cp on cp.cleaning_task_id=t.id
    where t.status='completed' and t.task_date <= v_month_end
    group by t.id,t.employee_id,t.task_date,t.amount
  ),
  per_employee as (
    select e.*,
      coalesce((select sum(o.remaining) from opening o where o.employee_id=e.id),0)
      + case when e.role='Təmizlik işçisi' then
          coalesce((select sum(cd.remaining) from cleaning_due cd where cd.employee_id=e.id and cd.task_date < v_month_start),0)
        else 0 end as previous_debt,
      case when e.role='Təmizlik işçisi' then
        coalesce((select sum(cd.remaining) from cleaning_due cd where cd.employee_id=e.id and cd.task_date between v_month_start and v_month_end),0)
      when e.role='Nəzarətçi' and e.salary_type='monthly' then
        greatest(0,e.base_salary-coalesce((
          select sum(sp.amount) from public.salary_payments sp
          where sp.employee_id=e.id and sp.period_start is not null and sp.period_end is not null
            and sp.period_start <= v_month_end and sp.period_end >= v_month_start
        ),0))
      else 0 end as current_month_debt,
      case when e.role='Təmizlik işçisi' then
        coalesce((select sum(cp.amount) from public.cleaning_task_payments cp
          join public.cleaning_tasks t on t.id=cp.cleaning_task_id
          where t.employee_id=e.id and cp.payment_date between v_month_start and v_month_end),0)
      when e.role='Nəzarətçi' then
        coalesce((select sum(sp.amount) from public.salary_payments sp
          where sp.employee_id=e.id and sp.payment_date between v_month_start and v_month_end),0)
      else 0 end as paid_this_month
    from active_employees e where e.role is not null
  ),
  people as (
    select id,full_name,position,role,round(previous_debt,2) as previous_debt,
      round(current_month_debt,2) as current_month_debt,
      round(previous_debt+current_month_debt,2) as total_due,
      round(paid_this_month,2) as paid_this_month
    from per_employee
  )
  select jsonb_build_object(
    'month',p_month,
    'employees',coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'name',full_name,'position',position,'role',role,
      'previousDebt',previous_debt,'currentMonthDebt',current_month_debt,
      'totalDue',total_due,'paidThisMonth',paid_this_month
    ) order by role,full_name) from people),'[]'::jsonb),
    'summary',jsonb_build_object(
      'totalDebt',coalesce((select sum(total_due) from people),0),
      'currentMonthRemaining',coalesce((select sum(current_month_debt) from people),0),
      'currentMonthPaid',coalesce((select sum(paid_this_month) from people),0)
    )
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.qth_get_employee_payroll_summary(text) from public,anon;
grant execute on function public.qth_get_employee_payroll_summary(text) to authenticated;
notify pgrst,'reload schema';
