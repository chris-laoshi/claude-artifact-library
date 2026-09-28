# Step 2: Supabase Edge Function

The function is deployed as `super-responder` (Supabase's default name — we're keeping it):
https://upobdjogsnjarngfoqso.supabase.co/functions/v1/super-responder

## Why it works this way
claude.ai blocks requests coming from Supabase's servers (403), and its page metadata is generic anyway ("Claude Artifact" and the same image for every artifact). So the function does **not** fetch claude.ai. Instead it asks **Microlink** (a screenshot service) to open the artifact in a real browser and take a picture of the first slide.

What the function does:
1. Checks you're logged in (valid Supabase login token).
2. Accepts only `https://claude.ai/artifact/<id>` links.
3. Asks Microlink for a 1280×800 JPEG screenshot (normal 1× sharpness, so roughly 100–300 KB — far under the 5 MB bucket limit).
4. Downloads the screenshot and saves it into the public `artifact-previews` bucket as `<your user id>/<artifact id>-<time>.jpg`.
5. Deletes any older screenshots of the same artifact (so "refresh preview" doesn't pile up files).
6. Returns the saved file path. If the screenshot fails, it still answers `ok: true` with `preview_path: null` and a `preview_error` reason — the app then shows the placeholder card and "refresh preview" can try again later.

There is no title in the reply: titles are typed by you in the app.

Microlink's free tier allows about 50 screenshots per day without an account.

## The code

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const BUCKET_NAME = 'artifact-previews';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the bucket's 5 MB limit
const MICROLINK_TIMEOUT_MS = 45000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Returns the artifact ID if the link is https://claude.ai/artifact/<id>, otherwise null.
function artifactIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'claude.ai') return null;
    const match = url.pathname.match(/^\/artifact\/([A-Za-z0-9_-]+)\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Asks Microlink to screenshot the artifact and returns the image bytes.
async function takeScreenshot(artifactUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const params = new URLSearchParams({
    url: artifactUrl,
    screenshot: 'true',
    meta: 'false',
    waitForTimeout: '4000',
    'screenshot.type': 'jpeg',
    'viewport.width': '1280',
    'viewport.height': '800',
    'viewport.deviceScaleFactor': '1',
  });

  const apiRes = await fetchWithTimeout(`https://api.microlink.io/?${params}`, MICROLINK_TIMEOUT_MS);
  const apiBody = await apiRes.json().catch(() => null);
  if (!apiRes.ok || apiBody?.status !== 'success') {
    const reason = apiBody?.message || apiBody?.code || `HTTP ${apiRes.status}`;
    throw new Error(`Microlink failed: ${reason}`);
  }

  const shotUrl = apiBody?.data?.screenshot?.url;
  if (!shotUrl) throw new Error('Microlink returned no screenshot');

  const imgRes = await fetchWithTimeout(shotUrl, MICROLINK_TIMEOUT_MS);
  if (!imgRes.ok) throw new Error(`Screenshot download failed: HTTP ${imgRes.status}`);

  const contentType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) throw new Error(`Screenshot is not an image (${contentType})`);

  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('Screenshot was empty');
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Screenshot too large (${bytes.byteLength} bytes)`);
  }
  return { bytes, contentType };
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Missing Supabase environment variables' });
  }

  // 1) Must be logged in
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ') || !authHeader.slice(7).trim()) {
    return json(401, { ok: false, error: 'Unauthorized: valid login required' });
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return json(401, { ok: false, error: 'Unauthorized: invalid or expired login' });
  }
  // Sign-ups are disabled and this is a single-account app, so a valid login is enough.
  const userId = userData.user.id;

  // 2) Must be a claude.ai artifact link
  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'Request body must be JSON' });
  }
  const artifactId = artifactIdFrom(body.url);
  if (!artifactId) {
    return json(400, { ok: false, error: 'Only https://claude.ai/artifact/... URLs are allowed' });
  }
  // Rebuild a clean link (drops any ?query or #hash that was pasted along with it)
  const artifactUrl = `https://claude.ai/artifact/${artifactId}`;

  // 3) Screenshot it and save it to Storage
  let previewPath: string | null = null;
  let previewError: string | null = null;
  try {
    const { bytes, contentType } = await takeScreenshot(artifactUrl);
    const objectPath = `${userId}/${artifactId}-${Date.now()}.${extensionFor(contentType)}`;

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error: uploadError } = await adminClient.storage
      .from(BUCKET_NAME)
      .upload(objectPath, bytes, { contentType, cacheControl: '31536000', upsert: false });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
    previewPath = objectPath;

    // Tidy up older screenshots of the same artifact (best effort)
    const { data: existing } = await adminClient.storage
      .from(BUCKET_NAME)
      .list(userId, { search: `${artifactId}-`, limit: 100 });
    const oldPaths = (existing || [])
      .map((f) => `${userId}/${f.name}`)
      .filter((p) => p !== objectPath && p.startsWith(`${userId}/${artifactId}-`));
    if (oldPaths.length) {
      await adminClient.storage.from(BUCKET_NAME).remove(oldPaths);
    }
  } catch (err) {
    previewError = err instanceof Error ? err.message : 'Unknown screenshot error';
  }

  return json(200, {
    ok: true,
    url: artifactUrl,
    preview_path: previewPath,
    preview_error: previewError,
  });
});
```

## How to update it in the Supabase dashboard

1. Go to https://supabase.com/dashboard and open your project (the same one as the notes app).
2. In the left sidebar, click **Edge Functions**.
3. Click **super-responder** in the list.
4. Open the **Code** tab.
5. Click inside the code, press **Ctrl+A** to select everything, then **Delete**.
6. Paste the whole code block above (everything between the ```ts and ``` lines, not including those lines).
7. Click **Deploy** (bottom-right) and wait for the green "deployed" message.
8. Nothing else needs changing: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to every function automatically.

## How to test it

Claude runs a PowerShell test script that signs in (email and password typed hidden, nothing saved), calls the function with the sample link, and checks the saved image opens.

The raw request looks like this:

```bash
curl -X POST "https://upobdjogsnjarngfoqso.supabase.co/functions/v1/super-responder" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://claude.ai/artifact/RFzFo4BPRZcUkufBM8G49R"}'
```

Expected reply:
- status 200
- `ok: true`
- `preview_path` like `YOUR_USER_ID/RFzFo4BPRZcUkufBM8G49R-1759000000000.jpg`
- `preview_error: null`
- The image at `https://upobdjogsnjarngfoqso.supabase.co/storage/v1/object/public/artifact-previews/<preview_path>` shows the first slide ("How Was Your Holiday?")

Should also be refused:
- no login → 401
- a non-claude.ai link → 400

## Important notes
- Only `https://claude.ai/artifact/<id>` links are accepted.
- A valid login is required.
- Only the file path is returned and stored — no signed URLs.
- The bucket is public for viewing; only the function (and logged-in users) can upload.
- Each refresh saves a new file name (so browsers don't show a stale cached picture) and deletes the old one.

## Next step
After the function is deployed and the test passes, then and only then do we build the app.
