# Step 1: Supabase SQL setup

This is the first setup step. Copy the SQL below into the Supabase SQL Editor and run it.

It creates:
- the links table
- the deleted tombstone pattern used by the notes app
- row-level security policies
- a storage bucket and upload/download rules
- a function for easy duplicate checking by URL

Important: this is the exact backend setup before any app code is built.

-- 1) Create the table
create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  url text not null,
  title text not null default '',
  preview_path text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- 2) Helpful index for user-scoped queries and duplicate checks
create index if not exists links_user_updated_idx
  on public.links (user_id, updated_at desc);

create index if not exists links_user_url_idx
  on public.links (user_id, url);

-- 3) RLS: enable
alter table public.links enable row level security;

-- 4) RLS policies
-- Only the logged-in user can see their own rows
create policy "Links are viewable by owner"
  on public.links
  for select
  using (auth.uid() = user_id);

-- Only the logged-in user can insert their own rows
create policy "Links can be inserted by owner"
  on public.links
  for insert
  with check (auth.uid() = user_id);

-- Only the logged-in user can update their own rows
create policy "Links can be updated by owner"
  on public.links
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Only the logged-in user can delete their own rows
-- We do tombstones, so this is usually an update to deleted = true
create policy "Links can be deleted by owner"
  on public.links
  for delete
  using (auth.uid() = user_id);

-- 5) Grant access for authenticated users
grant usage on schema public to authenticated;
grant all on public.links to authenticated;

grant usage on schema public to anon;

-- 6) Storage bucket: public for read access, uploads restricted to authenticated users
-- This bucket is for preview images that can be read by anyone on the web.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artifact-previews',
  'artifact-previews',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/svg+xml']
)
on conflict (id) do nothing;

-- 7) Storage policies
-- Anyone can view files in the public bucket
create policy "Public can view artifact previews"
  on storage.objects
  for select
  using (bucket_id = 'artifact-previews');

-- Only authenticated users can upload files into the bucket
create policy "Authenticated users can upload artifact previews"
  on storage.objects
  for insert
  with check (
    bucket_id = 'artifact-previews'
    and auth.role() = 'authenticated'
  );

-- Only authenticated users can update or delete files in the bucket
create policy "Authenticated users can update artifact previews"
  on storage.objects
  for update
  using (
    bucket_id = 'artifact-previews'
    and auth.role() = 'authenticated'
  );

create policy "Authenticated users can delete artifact previews"
  on storage.objects
  for delete
  using (
    bucket_id = 'artifact-previews'
    and auth.role() = 'authenticated'
  );

-- 8) Optional helper: quickly find an existing row by URL for the current user
create or replace function public.get_link_by_url_for_user(p_url text)
returns table (
  id uuid,
  user_id uuid,
  url text,
  title text,
  preview_path text,
  created_at timestamptz,
  updated_at timestamptz,
  deleted boolean
)
language sql
security definer
set search_path = public
as $$
  select id, user_id, url, title, preview_path, created_at, updated_at, deleted
  from public.links
  where user_id = auth.uid()
    and url = p_url
    and deleted = false
  limit 1;
$$;

grant execute on function public.get_link_by_url_for_user(text) to authenticated;

## What to do in the Supabase dashboard

1. Open your Supabase project.
2. Go to SQL Editor.
3. Paste the SQL above.
4. Click Run.
5. Confirm the table appears under Table Editor.
6. Confirm the bucket appears under Storage.
7. Confirm the row policies appear under Authentication > Policies or Storage > Policies.

## What this gives you
- A links table with the same deleted tombstone pattern as your notes app
- RLS so each user can only touch their own rows
- A public bucket for viewing preview images
- Uploads restricted to authenticated users only
- A simple duplicate lookup for the app later

## Next step
After this, the next step is the Edge Function setup. Do not build the app yet.
