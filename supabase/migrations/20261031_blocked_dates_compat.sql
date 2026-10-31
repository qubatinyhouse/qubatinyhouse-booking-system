-- Compatibility fix for existing BOOKING database blocked_dates table.
-- Existing production table uses UUID ids and may not yet have a note column.
alter table public.blocked_dates
  add column if not exists note text not null default '';
