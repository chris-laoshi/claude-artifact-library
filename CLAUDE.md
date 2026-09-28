# Claude Artifact Library

## What it is
A personal web app for saving links to my publicly shared Claude artifacts (claude.ai/artifact/...). I paste a link, press Enter, and it's saved as a card showing a preview image (the artifact's first slide) and its title. (The title is typed by me, not automatic — see below.) The whole card is a big clickable/tappable link that opens the artifact in a new tab. Must work well with a mouse and on a phone.

## Base it on my notes app
It should look, feel and work like my notes app at C:\Users\Chris\Documents\Claude Code\notes-app (live at https://chris-laoshi.github.io/notes-app/). READ that project for reference only — never modify anything in it. Reuse its approach:
- Plain HTML, CSS and ES-module JavaScript. No framework, no build step, no npm.
- Same design quality: Inter font, soft shadows, rounded cards, small animations, dark mode (follows system + toggle), friendly empty state, works on phones.
- Same local-first sync pattern as its storage_v2.js: IndexedDB copy on each device, background sync with Supabase (newest updatedAt wins, delete tombstones, sync on change/online/tab visible/every 60s), fetch against Supabase REST/auth endpoints instead of supabase-js, email+password login, sync status pill, sign out.
- Delete with a 5-second undo.
- Use the same deleted-column tombstone pattern as the notes app, not a hard delete. The app should set deleted = true instead of removing rows.

## The preview image
The browser can't read claude.ai pages directly (CORS), and claude.ai blocks requests from Supabase's servers too (403, blocked by where the request comes from, not User-Agent). Its og: metadata is also generic ("Claude Artifact" and the same claude_ogimage.png for every artifact), so it's useless anyway. Plan:
- The Supabase Edge Function "super-responder" (https://upobdjogsnjarngfoqso.supabase.co/functions/v1/super-responder) does NOT fetch claude.ai. It calls Microlink's screenshot API (https://api.microlink.io/?url=<artifact url>&screenshot=true&meta=false&waitForTimeout=4000, plus a 1280×800, 1× scale, JPEG viewport), downloads the screenshot (which shows the first slide) and saves it to the artifact-previews bucket. It must only accept claude.ai artifact URLs and only work for my logged-in account.
- Accepted link formats (app.js and the Edge Function use the same rule): claude.ai/artifact/<id>, claude.ai/public/artifacts/<id> and claude.site/artifacts/<id>, with or without www., ?query, #hash or a trailing slash. Links are stored cleaned (https, no query/hash/trailing slash) and duplicates are spotted by the cleaned link. Edge Function v2 code is in step4-supabase-edge-function-v2.md.
- Images stay small (1280px wide JPEG, well under the 5 MB bucket limit). Microlink's free tier is about 50 requests/day without an API key.
- The preview is saved in Supabase Storage so it loads fast, works on every device and doesn't depend on claude.ai or Microlink later.
- No auto-titles. When a link is saved, the new card appears with its title box ready to type into; titles are editable later.
- If the screenshot fails, show a neat placeholder card; "refresh preview" on each card tries again later.
- Test with https://claude.ai/artifact/RFzFo4BPRZcUkufBM8G49R (its first slide says "How Was Your Holiday?").
- Duplicate links should not be saved twice; if the link already exists, scroll to and highlight the existing card instead.

## Supabase database and storage plan
Use the same Supabase project and login as the notes app.
- Create a new table called links.
- Keep one row per saved artifact, owned by the logged-in user.
- Use a deleted boolean column for tombstones, matching the notes app pattern.
- Store only the preview file path in Supabase Storage, not signed URLs.
- Use a public storage bucket for viewing the image, but only authenticated users can upload to it.
- Sign-ups are disabled and I am the only account, so valid login is enough to protect the Edge Function.

## Hosting
GitHub Pages from a new public repo chris-laoshi/claude-artifact-library, main branch. Git identity must stay Chris <228512593+chris-laoshi@users.noreply.github.com> — never commit with a real email. I push with VS Code's Sync Changes button.

## How I want to work (most important)
- I'm not a coder. Explain things in plain language, and give step-by-step instructions whenever I need to do something in a website's settings (Supabase, GitHub).
- Plan first. For anything visual, make a static mockup (mockup_v1.html) first. Wait for my explicit go-ahead before building the real thing.
- Never overwrite files. New versions get new versioned files and the old ones are kept. Because GitHub Pages needs index.html, when a new version ships the current plain-named files get renamed with a version suffix and the new version takes the plain names.
- One or two changes at a time.
- Do database and Edge Function setup before any app build so the backend is validated first.

## My PC
Windows 11. Node and Python are NOT installed (Python is only the Microsoft Store stub). Git is at C:\Program Files\Git\cmd\git.exe. No gh CLI. So no Supabase CLI either — the Edge Function should be set up through the Supabase dashboard's editor, with you walking me through it. To test locally, use a small PowerShell HttpListener static server (ES modules don't load from file://) and headless Edge.

## Final working order
1. SQL setup in Supabase
2. Edge Function setup in Supabase
3. Test the function with my sample artifact URL and confirm the screenshot comes back (done — passed)
4. Only then build the app

## Decisions confirmed
1. Same Supabase project and login as the notes app
2. No automatic titles (claude.ai only gives "Claude Artifact"); I type the title when saving and can edit it afterward
3. Use the same deleted tombstone pattern as the notes app
4. Store only the preview path in Storage; keep the bucket public for reads and authenticated-only for uploads
5. Do not save duplicate links; scroll to and highlight the existing item if it exists
6. Include a refresh preview action on each card
7. SQL setup first, Edge Function second, verified test third, app build last
8. Layout: one long list, one row per artifact — name on the left, screenshot on the right; stays side by side on phones with a smaller screenshot (see mockup_v5.html)
9. Each row shows a small "Added YYYY-MM-DD" (e.g. "Added 2025-11-03"). This is the moment the link was first added (created_at), set once and NEVER changed afterwards — renaming, refreshing the preview or syncing must not touch it. No "updated" date is shown anywhere. The app sets created_at itself when the link is added (so an offline add keeps the right date) and must never send a new created_at for an existing row; updated_at is only used behind the scenes for sync. Show the date in my local time zone.
