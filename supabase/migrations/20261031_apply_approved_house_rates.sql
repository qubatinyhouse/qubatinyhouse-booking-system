-- Quba Tiny House: apply the owner-approved tariffs to the BOOKING database.
-- Safe to run more than once. Keeps existing unit IDs and reservation history intact.

alter table public.seasonal_rates
  add column if not exists weekday_rate numeric(10,2),
  add column if not exists weekend_rate numeric(10,2);

-- Keep the six live production unit IDs unchanged.
update public.units
set name = case id
  when 'scandi-large-1' then 'Orange House'
  when 'scandi-large-2' then 'White House'
  when 'scandi-small-1' then 'Blue House'
  when 'scandi-small-2' then 'Green House'
  when 'aframe-1' then 'A-FRAME-1'
  when 'aframe-2' then 'A-FRAME-2'
end,
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

-- Summer: June 1 through August 31 (checkout boundary September 1), years 2027-2035.
-- Update existing matching seasonal rows; insert only missing rows.
update public.seasonal_rates s
set nightly_rate = case
      when s.unit_id in ('scandi-small-1','scandi-small-2') then 130
      when s.unit_id in ('scandi-large-1','scandi-large-2') then 140
      else 200
    end,
    weekday_rate = case
      when s.unit_id in ('scandi-small-1','scandi-small-2') then 130
      when s.unit_id in ('scandi-large-1','scandi-large-2') then 140
      else 200
    end,
    weekend_rate = case
      when s.unit_id in ('scandi-small-1','scandi-small-2') then 150
      when s.unit_id in ('scandi-large-1','scandi-large-2') then 170
      else 250
    end,
    label = 'Yay mövsümü',
    active = true
where s.start_date = make_date(extract(year from s.start_date)::int, 6, 1)
  and s.end_date = make_date(extract(year from s.start_date)::int, 9, 1)
  and extract(year from s.start_date)::int between 2027 and 2035
  and s.unit_id in (
    'scandi-large-1','scandi-large-2',
    'scandi-small-1','scandi-small-2',
    'aframe-1','aframe-2'
  );

insert into public.seasonal_rates
  (unit_id,start_date,end_date,nightly_rate,weekday_rate,weekend_rate,label,active)
select u.id, make_date(y,6,1), make_date(y,9,1),
  case when u.id in ('scandi-small-1','scandi-small-2') then 130
       when u.id in ('scandi-large-1','scandi-large-2') then 140 else 200 end,
  case when u.id in ('scandi-small-1','scandi-small-2') then 130
       when u.id in ('scandi-large-1','scandi-large-2') then 140 else 200 end,
  case when u.id in ('scandi-small-1','scandi-small-2') then 150
       when u.id in ('scandi-large-1','scandi-large-2') then 170 else 250 end,
  'Yay mövsümü', true
from public.units u
cross join generate_series(2027,2035) as years(y)
where u.id in (
  'scandi-large-1','scandi-large-2',
  'scandi-small-1','scandi-small-2',
  'aframe-1','aframe-2'
)
and not exists (
  select 1 from public.seasonal_rates s
  where s.unit_id=u.id
    and s.start_date=make_date(y,6,1)
    and s.end_date=make_date(y,9,1)
);
