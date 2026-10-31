-- Quba Tiny House real tariff activation and weekday/weekend seasonal pricing.
-- Run this migration in the BOOKING Supabase project before deploying the matching function update.
alter table public.seasonal_rates
  add column if not exists weekday_rate numeric(10,2),
  add column if not exists weekend_rate numeric(10,2);

-- Base rates: September-May. Holiday rates use the weekend rate.
update public.units
set
  weekday_rate = case when unit_type = 'small' then 100 when unit_type = 'large' then 120 else 150 end,
  weekend_rate = case when unit_type = 'small' then 150 when unit_type = 'large' then 170 else 170 end,
  holiday_rate = case when unit_type = 'small' then 150 when unit_type = 'large' then 170 else 170 end,
  breakfast_rate_per_person = case when unit_type in ('small','large') then 15 else 0 end,
  is_demo_rate = false
where active = true;

-- Summer tariffs, repeated annually. End date is exclusive (1 September).
insert into public.seasonal_rates
  (unit_id, start_date, end_date, nightly_rate, weekday_rate, weekend_rate, label, active)
select
  u.id, make_date(y, 6, 1), make_date(y, 9, 1),
  case when u.unit_type = 'small' then 130 when u.unit_type = 'large' then 140 else 200 end,
  case when u.unit_type = 'small' then 130 when u.unit_type = 'large' then 140 else 200 end,
  case when u.unit_type = 'small' then 150 when u.unit_type = 'large' then 170 else 250 end,
  'Yay mövsümü', true
from public.units u
cross join generate_series(2027, 2035) as years(y)
where u.active = true
  and not exists (
    select 1 from public.seasonal_rates s
    where s.unit_id = u.id
      and s.start_date = make_date(y, 6, 1)
      and s.end_date = make_date(y, 9, 1)
  );
