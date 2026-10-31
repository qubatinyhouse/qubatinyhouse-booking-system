-- Quba Tiny House real tariff activation.
-- Run only in the BOOKING Supabase project. Preserve existing unit IDs
-- so reservation history and foreign keys remain intact.
alter table public.seasonal_rates
  add column if not exists weekday_rate numeric(10,2),
  add column if not exists weekend_rate numeric(10,2);

-- Rename the four existing Scandinavian units without changing IDs.
update public.units set name='Orange House', unit_type='large', capacity=7, sort_order=1
where id='scandi-large-1';
update public.units set name='White House', unit_type='large', capacity=7, sort_order=2
where id='scandi-large-2';
update public.units set name='Blue House', unit_type='small', capacity=4, sort_order=3
where id='scandi-small-1';
update public.units set name='Green House', unit_type='small', capacity=4, sort_order=4
where id='scandi-small-2';

-- Base tariffs: September-May. Only the six known houses are affected.
update public.units
set
  weekday_rate = case
    when id in ('scandi-small-1','scandi-small-2') then 100
    when id in ('scandi-large-1','scandi-large-2') then 120
    else 150
  end,
  weekend_rate = case
    when id in ('scandi-small-1','scandi-small-2') then 150
    else 170
  end,
  holiday_rate = case
    when id in ('scandi-small-1','scandi-small-2') then 150
    else 170
  end,
  is_demo_rate = false
where id in (
  'scandi-large-1','scandi-large-2',
  'scandi-small-1','scandi-small-2',
  'aframe-1','aframe-2'
);

-- Summer tariffs, June 1 inclusive through September 1 exclusive, 2027-2035.
insert into public.seasonal_rates
  (unit_id, start_date, end_date, nightly_rate, weekday_rate, weekend_rate, label, active)
select
  u.id,
  make_date(y, 6, 1),
  make_date(y, 9, 1),
  case
    when u.id in ('scandi-small-1','scandi-small-2') then 130
    when u.id in ('scandi-large-1','scandi-large-2') then 140
    else 200
  end,
  case
    when u.id in ('scandi-small-1','scandi-small-2') then 130
    when u.id in ('scandi-large-1','scandi-large-2') then 140
    else 200
  end,
  case
    when u.id in ('scandi-small-1','scandi-small-2') then 150
    when u.id in ('scandi-large-1','scandi-large-2') then 170
    else 250
  end,
  'Yay mövsümü',
  true
from public.units u
cross join generate_series(2027, 2035) as years(y)
where u.id in (
  'scandi-large-1','scandi-large-2',
  'scandi-small-1','scandi-small-2',
  'aframe-1','aframe-2'
)
and not exists (
  select 1
  from public.seasonal_rates s
  where s.unit_id = u.id
    and s.start_date = make_date(y, 6, 1)
    and s.end_date = make_date(y, 9, 1)
);
