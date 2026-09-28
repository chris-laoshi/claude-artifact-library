# Step 3: Lock the "Added" date

Each link shows "Added YYYY-MM-DD", taken from the `created_at` column. That date must never change once a link is added — not when it's renamed, not when its preview is refreshed, not when it syncs.

The app is written to never change it, but this makes the **database itself** enforce it: whenever a row in `links` is updated, `created_at` is quietly put back to what it was. So even a bug in the app can't change the date.

(Deleting a link and adding it again later counts as a new add, so it gets that day's date.)

## The SQL

```sql
-- Keep each link's "Added" date (created_at) fixed forever.
create or replace function public.links_keep_created_at()
returns trigger
language plpgsql
as $$
begin
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists links_keep_created_at on public.links;

create trigger links_keep_created_at
  before update on public.links
  for each row
  execute function public.links_keep_created_at();
```

## What to do in the Supabase dashboard

1. Go to https://supabase.com/dashboard and open your project (the same one as the notes app).
2. In the left sidebar, click **SQL Editor**.
3. Click **+ New query** (top-left of the editor) so you start with an empty box.
4. Paste the SQL above (everything between the ```sql and ``` lines, not those lines themselves).
5. Click **Run** (bottom-right), or press **Ctrl+Enter**.
6. You should see **"Success. No rows returned"**. That's the right result.
7. Optional check: in the left sidebar go to **Database → Triggers**. `links_keep_created_at` should be listed for the `links` table.

It's safe to run more than once.

## Next step
Build the app (index.html, styles.css, app.js, storage.js) from mockup_v5.html.
