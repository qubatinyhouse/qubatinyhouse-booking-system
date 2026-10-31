-- Quba Tiny House real tariff activation and four named Scandinavian units.
-- Run only in the BOOKING Supabase project. Existing unit IDs are retained
-- so reservation history and foreign keys remain intact.
alter table public.seasonal_rates
  add column if not exists weekday_rate numeric(10,2),
  add column if not exists weekend_rate numeric(10,2);

-- Rename existing Scandinavian records without changing their IDs.
update public.units set name='Orange House', unit_type='large', capacity=7, sort_order=1
where id in ('scandi-large-1','scandi-small-1','scandi-orange');
update public.units set name='White House', unit_type='large', capacity=7, sort_order=2
where id in ('scandi-large-2','scandi-white');
update public.units set name='Blue House', unit_type='small', capacity=4, sort_order=3
where id in ('scandi-small-2','scandi-blue');
update public.units set name='Green House', unit_type='small', capacity=4, sort_order=4
where id in ('scandi-green');

-- Real base tariffs (September-May). Breakfast is included only for Scandinavian houses.
update public.units
set
  weekday_rate = case when unit_type = 'small' then 100 when unit_type = 'large' then 120 else 150 end,
  weekend_rate = case when unit_type = 'small' then 150 when unit_type = 'large' then 170 else 170 end,
  holiday_rate = case when unit_type = 'small' then 150 when unit_type = 'large' then 170 else 170 end,
  breakfast_rate_per_person = case when unit_type in ('small','large') then 15 else 0 end,
  is_demo_rate = false
where active = true;

-- Summer tariffs: weekday/weekend. End date is exclusive (1 September).
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
