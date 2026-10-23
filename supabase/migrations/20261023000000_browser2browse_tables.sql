-- Dedicated Browser2Browse data inside the XBT Supabase project.
-- These are new, prefixed tables only. Existing XBT tables are not read or modified.
create table if not exists public.browser2browse_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz not null default now()
);
create table if not exists public.browser2browse_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null check (char_length(url) between 8 and 2048) check (url ~ '^https?://'),
  title text not null default '' check (char_length(title) <= 300),
  created_at timestamptz not null default now(),
  unique (user_id, url)
);
create table if not exists public.browser2browse_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null check (char_length(url) between 8 and 2048) check (url ~ '^https?://'),
  title text not null default '' check (char_length(title) <= 300),
  visited_at timestamptz not null default now()
);
create index if not exists browser2browse_history_user_visited_idx on public.browser2browse_history (user_id, visited_at desc);

alter table public.browser2browse_preferences enable row level security;
alter table public.browser2browse_bookmarks enable row level security;
alter table public.browser2browse_history enable row level security;
revoke all on public.browser2browse_preferences from anon;
revoke all on public.browser2browse_bookmarks from anon;
revoke all on public.browser2browse_history from anon;
grant select, insert, update, delete on public.browser2browse_preferences to authenticated;
grant select, insert, update, delete on public.browser2browse_bookmarks to authenticated;
grant select, insert, update, delete on public.browser2browse_history to authenticated;

drop policy if exists browser2browse_preferences_select_own on public.browser2browse_preferences;
create policy browser2browse_preferences_select_own on public.browser2browse_preferences for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists browser2browse_preferences_insert_own on public.browser2browse_preferences;
create policy browser2browse_preferences_insert_own on public.browser2browse_preferences for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_preferences_update_own on public.browser2browse_preferences;
create policy browser2browse_preferences_update_own on public.browser2browse_preferences for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_preferences_delete_own on public.browser2browse_preferences;
create policy browser2browse_preferences_delete_own on public.browser2browse_preferences for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists browser2browse_bookmarks_select_own on public.browser2browse_bookmarks;
create policy browser2browse_bookmarks_select_own on public.browser2browse_bookmarks for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists browser2browse_bookmarks_insert_own on public.browser2browse_bookmarks;
create policy browser2browse_bookmarks_insert_own on public.browser2browse_bookmarks for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_bookmarks_update_own on public.browser2browse_bookmarks;
create policy browser2browse_bookmarks_update_own on public.browser2browse_bookmarks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_bookmarks_delete_own on public.browser2browse_bookmarks;
create policy browser2browse_bookmarks_delete_own on public.browser2browse_bookmarks for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists browser2browse_history_select_own on public.browser2browse_history;
create policy browser2browse_history_select_own on public.browser2browse_history for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists browser2browse_history_insert_own on public.browser2browse_history;
create policy browser2browse_history_insert_own on public.browser2browse_history for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_history_update_own on public.browser2browse_history;
create policy browser2browse_history_update_own on public.browser2browse_history for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists browser2browse_history_delete_own on public.browser2browse_history;
create policy browser2browse_history_delete_own on public.browser2browse_history for delete to authenticated using ((select auth.uid()) = user_id);