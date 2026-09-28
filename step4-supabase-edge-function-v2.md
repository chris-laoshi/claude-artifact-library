# Step 4: Edge Function v2 — accept all Claude artifact link formats

This replaces the code from step 2 (step2-supabase-edge-function.md is kept as the record of version 1). Same function, same name: `super-responder`.

## What changed from version 1
Version 1 only accepted `https://claude.ai/artifact/<id>`. Claude also shares artifacts as `https://claude.ai/public/artifacts/<id>`, and older ones as `https://claude.site/artifacts/<id>`. Version 2 accepts all three (with or without `www.`, `?query`, `#hash` or a trailing slash). Links to anywhere else are still refused, and you still have to be logged in.

Everything else is unchanged: Microlink screenshot (1280×800 JPEG), saved to the `artifact-previews` bucket, older screenshots of the same artifact tidied up, and `preview_path: null` plus a `preview_error` reason if the screenshot fails.

The app (app.js) uses the same rule, so the two agree on what's allowed.

## The code

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const BUCKET_NAME = 'artifact-previews';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the bucket's 5 MB limit
const MICROLINK_TIMEOUT_MS = 45000;

// Claude artifact links look like one of these:
//   https://claude.ai/artifact/<id>
//   https://claude.ai/public/artifacts/<id>
//   https://claude.site/artifacts/<id>
const ARTIFACT_HOSTS = ['claude.ai', 'claude.site'];
const ARTIFACT_PATH = /^\/(?:public\/)?artifacts?\/([A-Za-z0-9_-]+)\/?$/i;

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

// If the link is a Claude artifact link, returns its id and a clean copy of
// the link (no ?query or #hash). Otherwise returns null.
function parseArtifactUrl(value: unknown): { id: string; url: string } | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!ARTIFACT_HOSTS.includes(host)) return null;
    const match = url.pathname.match(ARTIFACT_PATH);
    if (!match) return null;
    return { id: match[1], url: `https://${host}${url.pathname.replace(/\/$/, '')}` };
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

  // 2) Must be a Claude artifact link
  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'Request body must be JSON' });
  }
  const artifact = parseArtifactUrl(body.url);
  if (!artifact) {
    return json(400, { ok: false, error: 'Only Claude artifact links (claude.ai or claude.site) are allowed' });
  }
  const artifactId = artifact.id;
  const artifactUrl = artifact.url;

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

1. Go to https://supabase.com/dashboard and open your project.
2. In the left sidebar, click **Edge Functions**, then **super-responder**.
3. Open the **Code** tab.
4. Click inside the code, press **Ctrl+A**, then **Delete**.
5. Paste the whole code block above (everything between the ```ts and ``` lines, not those lines themselves).
6. Click **Deploy** and wait for the "deployed" message.

## How to check it
In the app, paste `https://claude.ai/public/artifacts/0e35be3e-389b-46bb-a8bb-faa375487642`. It should save, and after about 10 seconds the screenshot should appear. The old-style sample link `https://claude.ai/artifact/RFzFo4BPRZcUkufBM8G49R` must still work too.
