// server.js (FULL FILE REPLACEMENT)
// Social Feed MVP + Buckets + Multi-media + Collection/Trades pages
// - Feed page (/proxy/) shows composer + timeline
// - Posts support optional caption (500 max) + optional media (photos/videos)
// - Posts can include multiple media files
// - Like + comment on posts
// - Feed supports endless scroll via /feed/more?cursor=...
// - Uses signed-cookie session so links stay clean
// - Removes "Shop: ..." from all pages
// UPDATE:
// - Like button uses hearts (♡ / ♥) and is visible on mobile
// - Buckets (tabs): feed, collection, trades
//   - Posts made from feed or profile => bucket=feed
//   - Posts made from collection page => bucket=collection
//   - Posts made from trades page => bucket=trades
// - Collection page:
//   - Only shows posts bucket=collection
//   - Has a composer that REQUIRES at least 1 media file
//   - Timeline begins under the composer
//   - Two-column grid on desktop AND mobile
//   - Clicking media opens full screen viewer
// - Trades page: same bucket behavior as collection (required media), basic start
// - Comment rows show larger profile picture next to commenter name
// - Post header shows profile picture next to the post author name (same sizing as comments)
// - Comment text starts aligned under the commenter's name (not near the profile pic)
// - Feed top shows Gold Nugget logo (half-size)
// - Prevent HTML caching (no 304s for proxy pages)
// - Server logs do not include querystring

import express from "express";
import crypto from "crypto";
import { Pool } from "pg";
import multer from "multer";

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));

// Prevent 304/ETag caching globally for HTML pages
app.set("etag", false);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    // Log path only (no querystring)
    console.log(`${res.statusCode} ${req.method} ${req.path} (${ms}ms)`);
  });
  next();
});

const SHOPIFY_API_SECRET = (process.env.SHOPIFY_API_SECRET || "").trim();
const PORT = Number(process.env.PORT) || 3000;

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const GOLD_NUGGET_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0681/6589/4299/files/LOGO_w_TEXT_-_Gold_Nugget_467d90fd-4797-4d4f-9ddc-f86b47c98edf.png?v=1748970231";

/* ---------------------------
   Uploaders (multi-media)
---------------------------- */

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

const uploadPostMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB PER FILE
});

const MAX_MEDIA_FILES = 8;

function normalizeBucket(x) {
  const v = String(x || "").toLowerCase().trim();
  if (v === "collection" || v === "collections") return "collection";
  if (v === "trade" || v === "trades") return "trades";
  return "feed";
}

function bucketLabel(bucket) {
  if (bucket === "collection") return "Collections";
  if (bucket === "trades") return "Trades";
  return "Feed";
}

async function ensureSchema() {
  if (!pool) return;

  // Profiles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles_v2 (
      customer_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      dob DATE,
      favorite_pokemon TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS social_url TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_bytes BYTEA`);
  await pool.query(
    `ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_mime TEXT NOT NULL DEFAULT ''`
  );

  // Backfill NULLs
  await pool.query(`UPDATE profiles_v2 SET username = '' WHERE username IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET full_name = '' WHERE full_name IS NULL`);
  await pool.query(
    `UPDATE profiles_v2 SET favorite_pokemon = '' WHERE favorite_pokemon IS NULL`
  );
  await pool.query(`UPDATE profiles_v2 SET first_name = '' WHERE first_name IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET last_name = '' WHERE last_name IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET bio = '' WHERE bio IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET social_url = '' WHERE social_url IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET avatar_mime = '' WHERE avatar_mime IS NULL`);

  // Defaults + not null
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN username SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN full_name SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN favorite_pokemon SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN first_name SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN last_name SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN bio SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN social_url SET DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN avatar_mime SET DEFAULT ''`);

  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN username SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN full_name SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN favorite_pokemon SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN first_name SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN last_name SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN bio SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN social_url SET NOT NULL`);
  await pool.query(`ALTER TABLE profiles_v2 ALTER COLUMN avatar_mime SET NOT NULL`);

  // Posts (legacy single media columns kept for backward compatibility)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts_v1 (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      media_bytes BYTEA,
      media_mime TEXT NOT NULL DEFAULT '',
      bucket TEXT NOT NULL DEFAULT 'feed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure new bucket column exists if older table already created
  await pool.query(
    `ALTER TABLE posts_v1 ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'feed'`
  );

  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN body SET DEFAULT ''`);
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN media_mime SET DEFAULT ''`);
  await pool.query(`UPDATE posts_v1 SET body = '' WHERE body IS NULL`);
  await pool.query(`UPDATE posts_v1 SET media_mime = '' WHERE media_mime IS NULL`);
  await pool.query(
    `UPDATE posts_v1 SET bucket = 'feed' WHERE bucket IS NULL OR bucket = ''`
  );
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN body SET NOT NULL`);
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN media_mime SET NOT NULL`);
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN bucket SET NOT NULL`);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS posts_v1_shop_bucket_created_idx ON posts_v1 (shop, bucket, created_at DESC, id DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS posts_v1_customer_bucket_created_idx ON posts_v1 (customer_id, bucket, created_at DESC, id DESC)`
  );

  // Multi-media per post
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_media_v1 (
      post_id BIGINT NOT NULL,
      idx INT NOT NULL,
      media_bytes BYTEA NOT NULL,
      media_mime TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, idx)
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS post_media_v1_post_idx ON post_media_v1 (post_id)`
  );

  // Likes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS likes_v1 (
      shop TEXT NOT NULL,
      post_id BIGINT NOT NULL,
      customer_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, customer_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS likes_v1_post_idx ON likes_v1 (post_id)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS likes_v1_customer_idx ON likes_v1 (customer_id)`
  );

  // Comments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments_v1 (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      post_id BIGINT NOT NULL,
      customer_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE comments_v1 ALTER COLUMN body SET DEFAULT ''`);
  await pool.query(`UPDATE comments_v1 SET body = '' WHERE body IS NULL`);
  await pool.query(`ALTER TABLE comments_v1 ALTER COLUMN body SET NOT NULL`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS comments_v1_post_created_idx ON comments_v1 (post_id, created_at ASC)`
  );
}

/* ---------------------------
   Shopify proxy verification
---------------------------- */

function buildProxyMessage(query) {
  return Object.keys(query)
    .sort()
    .map((key) => {
      const val = query[key];
      const valueStr = Array.isArray(val) ? val.join(",") : String(val);
      return `${key}=${valueStr}`;
    })
    .join("");
}

function verifyShopifyProxy(req) {
  if (!SHOPIFY_API_SECRET) return false;

  const query = { ...req.query };
  const signature = typeof query.signature === "string" ? query.signature : "";
  if (!signature) return false;

  delete query.signature;

  const message = buildProxyMessage(query);
  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------
   Signed cookie session
---------------------------- */

const AUTH_COOKIE = "nd_auth";

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecodeToString(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const base64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

function signSession(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const data = b64urlEncode(json);
  const mac = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(data).digest("hex");
  return `${data}.${mac}`;
}

function verifySession(token) {
  if (!SHOPIFY_API_SECRET) return null;
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [data, mac] = parts;
  const expected = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(data).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = b64urlDecodeToString(data);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return null;

    if (typeof obj.customer_id !== "string" || !obj.customer_id) return null;
    if (typeof obj.shop !== "string" || !obj.shop) return null;
    if (typeof obj.path_prefix !== "string" || !obj.path_prefix) return null;

    if (obj.exp && Date.now() > Number(obj.exp)) return null;
    return obj;
  } catch {
    return null;
  }
}

function setAuthCookie(res, payload) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const token = signSession({
    customer_id: payload.customer_id,
    shop: payload.shop,
    path_prefix: payload.path_prefix,
    exp,
  });

  const parts = [];
  parts.push(`${AUTH_COOKIE}=${encodeURIComponent(token)}`);
  parts.push("Path=/proxy");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  parts.push("Secure");
  parts.push(`Max-Age=${7 * 24 * 60 * 60}`);

  res.setHeader("Set-Cookie", parts.join("; "));
}

/* ---------------------------
   Helpers
---------------------------- */

function basePathFromReq(req) {
  const p = typeof req.query.path_prefix === "string" ? req.query.path_prefix : "";
  if (p && p.startsWith("/")) return p;

  const cookies = parseCookies(req);
  const session = verifySession(cookies[AUTH_COOKIE]);
  const sp = session?.path_prefix || "";
  if (sp && sp.startsWith("/")) return sp;

  return "/apps/nuggetdepot";
}

function getViewerCustomerId(req) {
  const q =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  if (q) return q;

  const cookies = parseCookies(req);
  const session = verifySession(cookies[AUTH_COOKIE]);
  return session?.customer_id || "";
}

function getShop(req) {
  const q = typeof req.query.shop === "string" ? req.query.shop : "";
  if (q) return q;

  const cookies = parseCookies(req);
  const session = verifySession(cookies[AUTH_COOKIE]);
  return session?.shop || "";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(input, max = 80) {
  return String(input || "").trim().slice(0, max);
}
function cleanMultiline(input, max = 400) {
  return String(input || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}
function initialsFor(first, last) {
  const a = (first || "").trim().slice(0, 1).toUpperCase();
  const b = (last || "").trim().slice(0, 1).toUpperCase();
  const x = `${a}${b}`.trim();
  return x || "GN";
}
function svgAvatar(initials) {
  const safe = String(initials || "GN").replace(/[^A-Z0-9]/g, "").slice(0, 2) || "GN";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <rect width="240" height="240" rx="32" fill="#f2f2f2"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
        font-family="system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif"
        font-size="84" fill="#111">${safe}</text>
</svg>`;
}
function safeHandle(username) {
  const u = String(username || "").trim();
  if (!u) return "";
  return u.startsWith("@") ? u : `@${u}`;
}

function allowedMediaMime(m) {
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ]);
  return allowed.has(String(m || "").toLowerCase());
}

function isVideoMime(m) {
  return String(m || "").toLowerCase().startsWith("video/");
}

/* ---------------------------
   Pagination cursor
---------------------------- */

function encodeCursor(createdAt, id) {
  if (!createdAt || !id) return "";
  return b64urlEncode(`${new Date(createdAt).toISOString()}|${id}`);
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = b64urlDecodeToString(String(cursor));
    const [iso, idStr] = raw.split("|");
    const t = new Date(iso);
    const id = Number(idStr);
    if (!Number.isFinite(id) || isNaN(t.getTime())) return null;
    return { createdAt: t.toISOString(), id };
  } catch {
    return null;
  }
}

/* ---------------------------
   Page renderer
---------------------------- */

function page(bodyHtml, reqForBase) {
  const base = basePathFromReq(reqForBase);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Nugget Depot</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;line-height:1.35}
      a{color:inherit}
      .nav a{margin-right:12px}
      .card{border:1px solid #ddd;border-radius:12px;padding:16px;max-width:980px}
      code{background:#f5f5f5;padding:2px 6px;border-radius:6px}
      .muted{opacity:.75}
      .btn{display:inline-block;margin-top:12px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;text-decoration:none;background:white;cursor:pointer}
      input, textarea{padding:10px 12px;border:1px solid #ddd;border-radius:10px;width:100%;max-width:720px;font:inherit}
      textarea{min-height:160px;resize:vertical}
      label{display:block;margin-top:12px;margin-bottom:6px}
      .error{color:#b00020}
      hr{border:none;border-top:1px solid #eee;margin:12px 0}
      .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}

      .profileTop{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px}
      .avatarWrap{width:100%;display:flex;flex-direction:column;align-items:center;margin-top:6px}
      .avatarBox{position:relative;width:120px;height:120px}
      .avatar{width:120px;height:120px;border-radius:16px;object-fit:cover;aspect-ratio:1/1;border:1px solid #ddd;background:#fafafa;display:block}
      .avatarEdit{position:absolute;right:-8px;bottom:-8px;width:34px;height:34px;border-radius:10px;border:1px solid #ddd;background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.06);text-decoration:none}
      .fileInput{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .nameUnder{margin-top:10px;font-weight:800}
      .handleUnder{margin-top:4px}
      .small{font-size:13px}
      .stack{width:100%;max-width:920px}
      .help{margin-top:6px}

      .brandBar{
        width:100%;
        max-width:720px;
        display:flex;
        justify-content:center;
        align-items:center;
        margin:0 0 12px 0;
      }
      .brandLogo{
        max-width:160px;
        width:100%;
        height:auto;
        display:block;
      }

      .composer{
        width:100%;
        max-width:920px;
        border:1px solid #eee;
        border-radius:12px;
        padding:12px;
        margin-top:14px;
        background:#fff;
      }
      .composerTop{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .composerFake{
        flex:1;
        min-width:220px;
        border:1px solid #ddd;
        border-radius:10px;
        padding:10px 12px;
        text-decoration:none;
        background:#fafafa;
      }
      .iconBtn{
        border:1px solid #ddd;
        border-radius:10px;
        width:44px;
        height:44px;
        display:flex;
        align-items:center;
        justify-content:center;
        text-decoration:none;
        background:#fff;
      }

      .tabsRow{
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        margin-top:12px;
      }
      .tabBtn{
        border:1px solid #ddd;
        border-radius:999px;
        padding:10px 14px;
        text-decoration:none;
        background:#fff;
        font-weight:700;
      }
      .tabBtn.active{
        border-color:#111;
      }

      .collectionsRow{
        width:100%;
        max-width:720px;
        margin-top:12px;
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap:10px;
      }
      .collectionCard{
        border:1px solid #eee;
        border-radius:12px;
        padding:14px;
        text-decoration:none;
        background:#fff;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
      .collectionTitle{font-weight:800}
      .chev{opacity:.65}

      .postList{width:100%;max-width:920px;margin-top:14px}
      .postItem{border:1px solid #eee;border-radius:12px;padding:12px;margin-top:10px;background:#fff}

      .postHeader{
        display:flex;
        justify-content:space-between;
        gap:10px;
        flex-wrap:wrap;
        align-items:flex-start
      }
      .postAuthorRow{
        display:flex;
        align-items:center;
        gap:10px;
      }
      .postAuthorAvatar{
        width:45px;
        height:45px;
        border-radius:14px;
        object-fit:cover;
        border:1px solid #eee;
        background:#fafafa;
        flex:0 0 auto;
      }
      .postAuthor{font-weight:800}
      .postMetaRight{display:flex;gap:10px;align-items:center}

      .mediaGrid{
        width:100%;
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap:8px;
        margin-top:10px;
      }
      .mediaTile{
        width:100%;
        border-radius:12px;
        border:1px solid #eee;
        background:#fafafa;
        overflow:hidden;
        cursor:pointer;
        position:relative;
      }
      .mediaTile img, .mediaTile video{
        display:block;
        width:100%;
        height:100%;
        object-fit:cover;
        aspect-ratio: 1 / 1;
      }
      .mediaTile video{object-fit:cover}
      .mediaBadge{
        position:absolute;
        right:8px;
        top:8px;
        background:rgba(0,0,0,.65);
        color:#fff;
        border-radius:999px;
        padding:4px 8px;
        font-size:12px;
        font-weight:700;
      }

      .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
      .actionBtn{
        border:1px solid #ddd;
        border-radius:10px;
        padding:10px 12px;
        background:#fff;
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:8px;
        font-weight:800;
        line-height:1;
      }
      .actionBtn.liked{border-color:#111}
      .heartIcon{
        font-size:18px;
        line-height:1;
        display:inline-block;
      }

      .commentBox{margin-top:10px}
      .commentItem{border-top:1px solid #f0f0f0;padding-top:8px;margin-top:8px}

      .commentRow{
        display:flex;
        gap:10px;
        align-items:flex-start;
      }
      .commentAvatar{
        width:45px;
        height:45px;
        border-radius:14px;
        object-fit:cover;
        border:1px solid #eee;
        background:#fafafa;
        flex:0 0 auto;
        margin-top:1px;
      }
      .commentBody{
        flex:1;
        min-width:0;
      }
      .commentAuthor{font-weight:700; line-height:1.1}
      .commentText{white-space:pre-wrap; margin-top:4px}

      .divider{height:1px;background:#eee;margin:12px 0}

      /* Two-column grid for Collection + Trades timelines on ALL sizes */
      .bucketGrid{
        width:100%;
        margin-top:14px;
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap:10px;
      }
      .bucketGrid .postItem{
        margin-top:0;
      }

      /* Lightbox */
      .lb{
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.92);
        display:none;
        align-items:center;
        justify-content:center;
        z-index:9999;
        padding:18px;
      }
      .lb.show{display:flex}
      .lbInner{
        width:100%;
        height:100%;
        max-width:980px;
        max-height:980px;
        display:flex;
        flex-direction:column;
        gap:12px;
      }
      .lbTop{
        display:flex;
        justify-content:space-between;
        align-items:center;
        color:#fff;
        gap:10px;
      }
      .lbBtn{
        border:1px solid rgba(255,255,255,.35);
        background:transparent;
        color:#fff;
        border-radius:12px;
        padding:10px 12px;
        cursor:pointer;
        font-weight:800;
      }
      .lbStage{
        flex:1;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        border-radius:14px;
      }
      .lbStage img, .lbStage video{
        max-width:100%;
        max-height:100%;
        width:auto;
        height:auto;
        border-radius:14px;
        display:block;
      }
      .lbNav{
        display:flex;
        justify-content:center;
        gap:10px;
      }

      @media (max-width: 520px){
        body{margin:16px}
        .collectionsRow{grid-template-columns: 1fr}
        .actionBtn{padding:10px 10px}
        .heartIcon{font-size:20px}
      }
    </style>
  </head>
  <body>
    <div class="nav">
      <a href="${base}">Feed</a>
      <a href="${base}/me">My Profile</a>
      <a href="${base}/collection">My Collection</a>
      <a href="${base}/trades">Trades</a>
    </div>
    <hr/>
    <div class="card">
      ${bodyHtml}
    </div>

    <div class="lb" id="lb">
      <div class="lbInner">
        <div class="lbTop">
          <div id="lbTitle" class="small"></div>
          <button class="lbBtn" type="button" id="lbClose">Close</button>
        </div>
        <div class="lbStage" id="lbStage"></div>
        <div class="lbNav">
          <button class="lbBtn" type="button" id="lbPrev">Prev</button>
          <button class="lbBtn" type="button" id="lbNext">Next</button>
        </div>
      </div>
    </div>

    <script>
      (function(){
        const lb = document.getElementById('lb');
        const stage = document.getElementById('lbStage');
        const title = document.getElementById('lbTitle');
        const closeBtn = document.getElementById('lbClose');
        const prevBtn = document.getElementById('lbPrev');
        const nextBtn = document.getElementById('lbNext');

        let items = [];
        let idx = 0;

        function setStage(){
          if (!stage) return;
          stage.innerHTML = '';
          const it = items[idx];
          if (!it) return;

          title.textContent = (idx + 1) + ' / ' + items.length;

          if (it.type === 'video'){
            const v = document.createElement('video');
            v.src = it.src;
            v.controls = true;
            v.playsInline = true;
            stage.appendChild(v);
          } else {
            const im = document.createElement('img');
            im.src = it.src;
            im.alt = '';
            stage.appendChild(im);
          }
        }

        function openLightbox(group, start){
          const els = document.querySelectorAll('[data-lb-group="' + group + '"]');
          const nextItems = [];
          els.forEach((el) => {
            const src = el.getAttribute('data-lb-src') || '';
            const type = el.getAttribute('data-lb-type') || 'image';
            if (src) nextItems.push({ src, type });
          });
          if (!nextItems.length) return;

          items = nextItems;
          idx = Math.max(0, Math.min(items.length - 1, Number(start) || 0));
          setStage();

          if (lb) lb.classList.add('show');
          document.body.style.overflow = 'hidden';
        }

        function closeLightbox(){
          if (lb) lb.classList.remove('show');
          if (stage) stage.innerHTML = '';
          document.body.style.overflow = '';
          items = [];
          idx = 0;
        }

        document.addEventListener('click', (e) => {
          const t = e.target;
          if (!(t instanceof HTMLElement)) return;

          const tile = t.closest && t.closest('[data-lb-open="1"]');
          if (tile){
            const group = tile.getAttribute('data-lb-group') || '';
            const start = tile.getAttribute('data-lb-idx') || '0';
            if (group) openLightbox(group, start);
          }
        });

        if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
        if (lb) lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

        function prev(){
          if (!items.length) return;
          idx = (idx - 1 + items.length) % items.length;
          setStage();
        }
        function next(){
          if (!items.length) return;
          idx = (idx + 1) % items.length;
          setStage();
        }

        if (prevBtn) prevBtn.addEventListener('click', prev);
        if (nextBtn) nextBtn.addEventListener('click', next);

        document.addEventListener('keydown', (e) => {
          if (!lb || !lb.classList.contains('show')) return;
          if (e.key === 'Escape') closeLightbox();
          if (e.key === 'ArrowLeft') prev();
          if (e.key === 'ArrowRight') next();
        });
      })();
    </script>
  </body>
</html>`;
}

/* ---------------------------
   Auth middleware
---------------------------- */

function requireProxyAuth(req, res, next) {
  if (!SHOPIFY_API_SECRET) {
    return res
      .status(200)
      .type("html")
      .send(page(`<p class="error">Missing SHOPIFY_API_SECRET</p>`, req));
  }

  if (verifyShopifyProxy(req)) {
    const shop = typeof req.query.shop === "string" ? req.query.shop : "";
    const customerId =
      typeof req.query.logged_in_customer_id === "string"
        ? req.query.logged_in_customer_id
        : "";
    const pathPrefix =
      typeof req.query.path_prefix === "string"
        ? req.query.path_prefix
        : "/apps/nuggetdepot";
    if (shop && customerId && pathPrefix) {
      setAuthCookie(res, { shop, customer_id: customerId, path_prefix: pathPrefix });
    }
    return next();
  }

  const cookies = parseCookies(req);
  const session = verifySession(cookies[AUTH_COOKIE]);
  if (session) return next();

  const keys = Object.keys(req.query || {}).sort().join(", ");
  return res.status(200).type("html").send(
    page(
      `
        <p class="error">Invalid proxy signature.</p>
        <p class="muted">Path: <code>${escapeHtml(req.originalUrl)}</code></p>
        <p class="muted">Query keys: <code>${escapeHtml(keys || "none")}</code></p>
      `,
      req
    )
  );
}

/* ---------------------------
   Proxy routes
---------------------------- */

const proxy = express.Router();
proxy.use(requireProxyAuth);

// Force no-cache for all proxy responses (prevents 304s for HTML)
proxy.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

/* ---------------------------
   DB helpers
---------------------------- */

async function getProfile(customerId) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(
    `SELECT customer_id, shop, username, first_name, last_name, bio, social_url, avatar_mime
     FROM profiles_v2
     WHERE customer_id=$1`,
    [customerId]
  );
  return r.rows?.[0] || null;
}

async function getAvatar(customerId) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(
    `SELECT avatar_bytes, avatar_mime, first_name, last_name
     FROM profiles_v2
     WHERE customer_id=$1`,
    [customerId]
  );
  return r.rows?.[0] || null;
}

async function ensureRow(customerId, shop) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  await pool.query(
    `INSERT INTO profiles_v2 (
        customer_id, shop,
        username, full_name, favorite_pokemon,
        first_name, last_name, bio, social_url, avatar_mime
     )
     VALUES ($1,$2,'','','','','','','','')
     ON CONFLICT (customer_id)
     DO UPDATE SET shop=EXCLUDED.shop, updated_at=NOW()`,
    [customerId, shop]
  );
}

async function updateProfile(customerId, patch) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  const keys = Object.keys(patch);
  if (keys.length === 0) return;

  const sets = [];
  const vals = [];
  let i = 1;

  for (const k of keys) {
    sets.push(`${k}=$${i++}`);
    vals.push(patch[k]);
  }
  vals.push(customerId);

  await pool.query(
    `UPDATE profiles_v2 SET ${sets.join(", ")}, updated_at=NOW() WHERE customer_id=$${i}`,
    vals
  );
}

async function createPost({ shop, customerId, body, bucket }) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  const b = normalizeBucket(bucket);

  const r = await pool.query(
    `INSERT INTO posts_v1 (shop, customer_id, body, bucket)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [shop, customerId, body || "", b]
  );
  return r.rows?.[0]?.id || null;
}

async function addPostMedia(postId, mediaItems) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();
  if (!postId) return;

  const items = Array.isArray(mediaItems) ? mediaItems : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.bytes || !it?.mime) continue;
    await pool.query(
      `INSERT INTO post_media_v1 (post_id, idx, media_bytes, media_mime) VALUES ($1,$2,$3,$4)`,
      [postId, i, it.bytes, it.mime]
    );
  }
}

async function getPostMediaRow(postId, idx) {
  if (!pool) return null;
  await ensureSchema();

  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0) return null;

  const r = await pool.query(
    `SELECT media_bytes, media_mime FROM post_media_v1 WHERE post_id=$1 AND idx=$2`,
    [postId, i]
  );
  if (r.rows?.[0]?.media_bytes && r.rows?.[0]?.media_mime) return r.rows[0];

  if (i === 0) {
    const legacy = await pool.query(`SELECT media_bytes, media_mime FROM posts_v1 WHERE id=$1`, [
      postId,
    ]);
    if (legacy.rows?.[0]?.media_bytes && legacy.rows?.[0]?.media_mime) return legacy.rows[0];
  }

  return null;
}

async function getPostMediaMeta(postIds) {
  const byPostId = {};
  for (const id of postIds) {
    byPostId[id] = { media_count: 0, media_types: [] };
  }
  if (!pool || postIds.length === 0) return { byPostId };
  await ensureSchema();

  const r = await pool.query(
    `SELECT post_id, COUNT(*)::int AS cnt
     FROM post_media_v1
     WHERE post_id = ANY($1::bigint[])
     GROUP BY post_id`,
    [postIds]
  );
  for (const row of r.rows || []) {
    if (byPostId[row.post_id]) byPostId[row.post_id].media_count = Number(row.cnt) || 0;
  }

  const r2 = await pool.query(
    `SELECT post_id, idx, media_mime
     FROM post_media_v1
     WHERE post_id = ANY($1::bigint[])
     ORDER BY post_id, idx ASC`,
    [postIds]
  );
  for (const row of r2.rows || []) {
    if (!byPostId[row.post_id]) continue;
    byPostId[row.post_id].media_types.push({
      idx: Number(row.idx) || 0,
      mime: row.media_mime || "",
    });
  }

  const legacy = await pool.query(
    `SELECT id, media_mime
     FROM posts_v1
     WHERE id = ANY($1::bigint[])`,
    [postIds]
  );
  for (const row of legacy.rows || []) {
    const pid = Number(row.id);
    if (!byPostId[pid]) continue;
    if (byPostId[pid].media_count > 0) continue;
    const mm = String(row.media_mime || "").trim();
    if (mm) {
      byPostId[pid].media_count = 1;
      byPostId[pid].media_types = [{ idx: 0, mime: mm }];
    }
  }

  return { byPostId };
}

async function listPostsForCustomerWithMeta({ targetCustomerId, viewerCustomerId, limit = 20 }) {
  if (!pool) return { posts: [], nextCursor: "" };
  await ensureSchema();

  const r = await pool.query(
    `
    SELECT
      p.id, p.shop, p.customer_id, p.body, p.bucket, p.created_at,
      pr.first_name, pr.last_name, pr.username
    FROM posts_v1 p
    LEFT JOIN profiles_v2 pr ON pr.customer_id = p.customer_id
    WHERE p.customer_id = $1 AND p.bucket = 'feed'
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT $2
    `,
    [targetCustomerId, limit]
  );

  const posts = r.rows || [];
  const postIds = posts.map((x) => Number(x.id)).filter((x) => Number.isFinite(x));

  const meta = await getPostsMeta(postIds, viewerCustomerId);
  const mediaMeta = await getPostMediaMeta(postIds);

  const nextCursor =
    posts.length === limit
      ? encodeCursor(posts[posts.length - 1].created_at, posts[posts.length - 1].id)
      : "";

  return {
    posts: posts.map((p) => ({
      ...p,
      ...meta.byPostId[p.id],
      ...mediaMeta.byPostId[p.id],
    })),
    nextCursor,
  };
}

async function listBucketPostsWithMeta({
  shop,
  viewerCustomerId,
  bucket = "feed",
  limit = 20,
  cursor = null,
}) {
  if (!pool) return { posts: [], nextCursor: "" };
  await ensureSchema();

  const b = normalizeBucket(bucket);

  const params = [shop, b, limit];
  let cursorClause = "";

  if (cursor?.createdAt && cursor?.id) {
    cursorClause = ` AND (p.created_at < $4 OR (p.created_at = $4 AND p.id < $5))`;
    params.push(cursor.createdAt, cursor.id);
  }

  const r = await pool.query(
    `
    SELECT
      p.id, p.shop, p.customer_id, p.body, p.bucket, p.created_at,
      pr.first_name, pr.last_name, pr.username
    FROM posts_v1 p
    LEFT JOIN profiles_v2 pr ON pr.customer_id = p.customer_id
    WHERE p.shop = $1 AND p.bucket = $2${cursorClause}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT $3
    `,
    params
  );

  const posts = r.rows || [];
  const postIds = posts.map((x) => Number(x.id)).filter((x) => Number.isFinite(x));
  const meta = await getPostsMeta(postIds, viewerCustomerId);
  const mediaMeta = await getPostMediaMeta(postIds);

  const nextCursor =
    posts.length === limit
      ? encodeCursor(posts[posts.length - 1].created_at, posts[posts.length - 1].id)
      : "";

  return {
    posts: posts.map((p) => ({
      ...p,
      ...meta.byPostId[p.id],
      ...mediaMeta.byPostId[p.id],
    })),
    nextCursor,
  };
}

async function getPostsMeta(postIds, viewerCustomerId) {
  const byPostId = {};
  for (const id of postIds) {
    byPostId[id] = {
      like_count: 0,
      comment_count: 0,
      viewer_liked: false,
      comments_preview: [],
    };
  }
  if (!pool || postIds.length === 0) return { byPostId };

  const likesR = await pool.query(
    `SELECT post_id, COUNT(*)::int AS cnt
     FROM likes_v1
     WHERE post_id = ANY($1::bigint[])
     GROUP BY post_id`,
    [postIds]
  );
  for (const row of likesR.rows || []) {
    if (byPostId[row.post_id]) byPostId[row.post_id].like_count = Number(row.cnt) || 0;
  }

  if (viewerCustomerId) {
    const viewerR = await pool.query(
      `SELECT post_id
       FROM likes_v1
       WHERE post_id = ANY($1::bigint[]) AND customer_id = $2`,
      [postIds, viewerCustomerId]
    );
    for (const row of viewerR.rows || []) {
      if (byPostId[row.post_id]) byPostId[row.post_id].viewer_liked = true;
    }
  }

  const cCountR = await pool.query(
    `SELECT post_id, COUNT(*)::int AS cnt
     FROM comments_v1
     WHERE post_id = ANY($1::bigint[])
     GROUP BY post_id`,
    [postIds]
  );
  for (const row of cCountR.rows || []) {
    if (byPostId[row.post_id]) byPostId[row.post_id].comment_count = Number(row.cnt) || 0;
  }

  const cR = await pool.query(
    `
    SELECT * FROM (
      SELECT
        c.post_id, c.body, c.created_at, c.customer_id,
        pr.first_name, pr.last_name, pr.username,
        ROW_NUMBER() OVER (PARTITION BY c.post_id ORDER BY c.created_at DESC, c.id DESC) AS rn
      FROM comments_v1 c
      LEFT JOIN profiles_v2 pr ON pr.customer_id = c.customer_id
      WHERE c.post_id = ANY($1::bigint[])
    ) t
    WHERE t.rn <= 2
    ORDER BY t.post_id, t.created_at ASC
    `,
    [postIds]
  );

  for (const row of cR.rows || []) {
    if (!byPostId[row.post_id]) continue;
    byPostId[row.post_id].comments_preview.push({
      body: row.body || "",
      created_at: row.created_at,
      first_name: row.first_name || "",
      last_name: row.last_name || "",
      username: row.username || "",
      customer_id: row.customer_id || "",
    });
  }

  return { byPostId };
}

async function toggleLike({ shop, postId, customerId }) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  try {
    await pool.query(`INSERT INTO likes_v1 (shop, post_id, customer_id) VALUES ($1,$2,$3)`, [
      shop,
      postId,
      customerId,
    ]);
    return { liked: true };
  } catch {
    await pool.query(`DELETE FROM likes_v1 WHERE post_id=$1 AND customer_id=$2`, [
      postId,
      customerId,
    ]);
    return { liked: false };
  }
}

async function addComment({ shop, postId, customerId, body }) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();
  await pool.query(
    `INSERT INTO comments_v1 (shop, post_id, customer_id, body) VALUES ($1,$2,$3,$4)`,
    [shop, postId, customerId, body]
  );
}

/* ---------------------------
   Rendering helpers
---------------------------- */

function renderTabs({ base, active }) {
  const a = normalizeBucket(active);
  const feedHref = `${base}?tab=feed`;
  const colHref = `${base}?tab=collection`;
  const trdHref = `${base}?tab=trades`;

  return `
    <div class="tabsRow">
      <a class="tabBtn ${a === "feed" ? "active" : ""}" href="${feedHref}">Feed</a>
      <a class="tabBtn ${a === "collection" ? "active" : ""}" href="${colHref}">Collections</a>
      <a class="tabBtn ${a === "trades" ? "active" : ""}" href="${trdHref}">Trades</a>
    </div>
  `;
}

function renderInlineBucketComposer({ base, bucket, returnTo, requireMedia }) {
  const b = normalizeBucket(bucket);
  const title = bucketLabel(b);

  return `
    <div class="composer">
      <div style="font-weight:900">${escapeHtml(title)} Post</div>
      <div class="muted small help">${requireMedia ? "Media is required on this page." : "Media optional."} Up to ${MAX_MEDIA_FILES} files.</div>

      <form method="POST" enctype="multipart/form-data" action="${base}/post/new" style="margin-top:10px">
        <input type="hidden" name="return" value="${escapeHtml(returnTo)}" />
        <input type="hidden" name="bucket" value="${escapeHtml(b)}" />

        <label for="b_${b}_body">Caption (optional)</label>
        <textarea id="b_${b}_body" name="body" maxlength="500" placeholder="Write something (max 500 characters)" style="min-height:120px"></textarea>

        <label for="b_${b}_media">Photo or video ${requireMedia ? "(required)" : "(optional)"}</label>
        <input id="b_${b}_media" type="file" name="media" ${requireMedia ? "required" : ""} multiple accept="image/*,video/*" />

        <div class="row">
          <button class="btn" type="submit">Post</button>
        </div>

        <div class="muted small help">15MB max per file.</div>
      </form>
    </div>
  `;
}

function renderPostMediaHtml({ base, post }) {
  const id = Number(post.id);
  const types = Array.isArray(post.media_types) ? post.media_types : [];
  const count = Number(post.media_count || 0);

  if (!count || !types.length) return "";

  const group = `post-${id}`;
  const tiles = types
    .slice(0, MAX_MEDIA_FILES)
    .map((t) => {
      const idx = Number(t.idx) || 0;
      const mime = String(t.mime || "");
      const src = `${base}/posts/${id}/media/${idx}`;
      const isVid = isVideoMime(mime);
      const badge = count > 1 ? `<div class="mediaBadge">${count}</div>` : "";

      if (isVid) {
        return `
        <div class="mediaTile" data-lb-open="1" data-lb-group="${group}" data-lb-idx="${idx}" data-lb-src="${src}" data-lb-type="video">
          ${badge}
          <video muted playsinline preload="metadata" src="${src}"></video>
        </div>
      `;
      }

      return `
      <div class="mediaTile" data-lb-open="1" data-lb-group="${group}" data-lb-idx="${idx}" data-lb-src="${src}" data-lb-type="image">
        ${badge}
        <img src="${src}" alt="Post media" />
      </div>
    `;
    })
    .join("");

  const hiddenAll = types
    .slice(0, MAX_MEDIA_FILES)
    .map((t) => {
      const idx = Number(t.idx) || 0;
      const mime = String(t.mime || "");
      const src = `${base}/posts/${id}/media/${idx}`;
      const type = isVideoMime(mime) ? "video" : "image";
      return `<span style="display:none" data-lb-group="${group}" data-lb-src="${src}" data-lb-type="${type}"></span>`;
    })
    .join("");

  return `<div class="mediaGrid">${tiles}</div>${hiddenAll}`;
}

/* ---------------------------
   Post card renderer
---------------------------- */

function renderPostCard({ post, base, viewerId, showAuthorLink = true, returnPath }) {
  const id = Number(post.id);
  const authorName = `${post.first_name || ""} ${post.last_name || ""}`.trim() || "User";
  const handle = safeHandle(post.username || "");
  const when = new Date(post.created_at).toLocaleString();

  const body = escapeHtml(post.body || "");

  const authorHref = `${base}/u/${encodeURIComponent(post.customer_id)}`;
  const authorAvatar = `${base}/avatar/${encodeURIComponent(post.customer_id || "")}`;

  const authorNameHtml = showAuthorLink
    ? `<a href="${authorHref}" class="postAuthor">${escapeHtml(authorName)}</a>`
    : `<div class="postAuthor">${escapeHtml(authorName)}</div>`;

  const handleHtml = handle ? `<div class="muted small">${escapeHtml(handle)}</div>` : "";

  const likeCount = Number(post.like_count || 0);
  const commentCount = Number(post.comment_count || 0);
  const liked = !!post.viewer_liked;

  const likeAction = `${base}/posts/${id}/like`;
  const commentAction = `${base}/posts/${id}/comment`;

  const returnInput = `<input type="hidden" name="return" value="${escapeHtml(returnPath || "")}" />`;

  const commentsPreview = Array.isArray(post.comments_preview) ? post.comments_preview : [];
  const previewHtml =
    commentsPreview.length === 0
      ? ""
      : commentsPreview
          .map((c) => {
            const cn = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "User";
            const cAvatar = `${base}/avatar/${encodeURIComponent(c.customer_id || "")}`;
            return `
              <div class="commentItem">
                <div class="commentRow">
                  <img class="commentAvatar" src="${cAvatar}" alt="" />
                  <div class="commentBody">
                    <div class="commentAuthor">${escapeHtml(cn)}</div>
                    <div class="small commentText">${escapeHtml(c.body || "")}</div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

  const mediaHtml = renderPostMediaHtml({ base, post });

  return `
    <div class="postItem" id="post-${id}">
      <div class="postHeader">
        <div class="postAuthorRow">
          <img class="postAuthorAvatar" src="${authorAvatar}" alt="" />
          <div>
            ${authorNameHtml}
            ${handleHtml}
            <div class="muted small">${escapeHtml(when)}</div>
          </div>
        </div>
        <div class="postMetaRight"></div>
      </div>

      ${body ? `<p style="margin:10px 0 0 0;white-space:pre-wrap">${body}</p>` : ""}
      ${mediaHtml}

      <div class="actions">
        <form method="POST" action="${likeAction}" style="margin:0">
          ${returnInput}
          <button class="actionBtn ${liked ? "liked" : ""}" type="submit" aria-label="Like">
            <span class="heartIcon">${liked ? "♥" : "♡"}</span>
            <span>${likeCount}</span>
          </button>
        </form>

        <span class="muted small">Comments: ${commentCount}</span>
      </div>

      <div class="commentBox">
        ${previewHtml}
        <form method="POST" action="${commentAction}" style="margin-top:10px">
          ${returnInput}
          <input name="comment" maxlength="300" placeholder="Write a comment..." />
          <button class="btn" type="submit" style="margin-top:10px">Comment</button>
        </form>
      </div>
    </div>
  `;
}

/* ---------------------------
   Non-proxy root
---------------------------- */

app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Nugget Depot</h1>
    <p>Server is live.</p>
    <ul>
      <li><a href="/healthz">Health Check</a></li>
      <li>Shopify App Proxy entry: <code>/proxy</code> (requires signed request)</li>
    </ul>
  `);
});
app.get("/healthz", (req, res) => res.status(200).type("text").send("ok"));

/* ---------------------------
   Proxy endpoints
---------------------------- */

/** Avatar (me) */
proxy.get("/me/avatar", async (req, res) => {
  const customerId = getViewerCustomerId(req);
  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  try {
    const a = await getAvatar(customerId);

    if (a?.avatar_bytes && a?.avatar_mime) {
      res.setHeader("Content-Type", a.avatar_mime);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(a.avatar_bytes);
    }

    const ini = initialsFor(a?.first_name || "", a?.last_name || "");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(svgAvatar(ini));
  } catch (e) {
    console.error("avatar error:", e);
    return res.status(200).type("text").send("Avatar error");
  }
});

/** Avatar for any user (used in comments + post headers, requires login) */
proxy.get("/avatar/:customerId", async (req, res) => {
  const viewerId = getViewerCustomerId(req);
  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const targetId = String(req.params.customerId || "").trim();
  if (!targetId) return res.status(404).type("text").send("Not found");

  try {
    const a = await getAvatar(targetId);

    if (a?.avatar_bytes && a?.avatar_mime) {
      res.setHeader("Content-Type", a.avatar_mime);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(a.avatar_bytes);
    }

    const ini = initialsFor(a?.first_name || "", a?.last_name || "");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(svgAvatar(ini));
  } catch (e) {
    console.error("avatar public error:", e);
    return res.status(200).type("text").send("Avatar error");
  }
});

/** Post media (multi) */
proxy.get("/posts/:id/media/:idx", async (req, res) => {
  const customerId = getViewerCustomerId(req);
  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  if (!Number.isFinite(id) || !Number.isFinite(idx))
    return res.status(404).type("text").send("Not found");

  try {
    const m = await getPostMediaRow(id, idx);
    if (!m?.media_bytes || !m?.media_mime) return res.status(404).type("text").send("Not found");

    res.setHeader("Content-Type", m.media_mime);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(m.media_bytes);
  } catch (e) {
    console.error("post media error:", e);
    return res.status(200).type("text").send("Media error");
  }
});

/** Backward compatible single media route (FIXED: no proxy.handle recursion) */
proxy.get("/posts/:id/media", async (req, res) => {
  const customerId = getViewerCustomerId(req);
  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).type("text").send("Not found");

  try {
    const m = await getPostMediaRow(id, 0);
    if (!m?.media_bytes || !m?.media_mime) return res.status(404).type("text").send("Not found");

    res.setHeader("Content-Type", m.media_mime);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(m.media_bytes);
  } catch (e) {
    console.error("post media legacy error:", e);
    return res.status(200).type("text").send("Media error");
  }
});

/** Feed page (tabs) */
proxy.get("/", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>Please log in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  await ensureRow(viewerId, shop);

  const tab = normalizeBucket(typeof req.query.tab === "string" ? req.query.tab : "feed");

  const newPostHref = `${base}/post/new?return=feed&bucket=feed`;

  const { posts, nextCursor } = await listBucketPostsWithMeta({
    shop,
    viewerCustomerId: viewerId,
    bucket: tab,
    limit: 15,
    cursor: null,
  });

  const postsHtml =
    posts.length === 0
      ? `<div class="postList"><p class="muted">No posts yet.</p></div>`
      : `<div class="postList" id="feedList">
          ${posts
            .map((p) =>
              renderPostCard({
                post: p,
                base,
                viewerId,
                showAuthorLink: true,
                returnPath: `${base}?tab=${tab}`,
              })
            )
            .join("")}
        </div>`;

  const moreBlock = `
    <div class="divider"></div>
    <div id="feedMore" data-next="${escapeHtml(nextCursor || "")}" data-tab="${escapeHtml(tab)}">
      <div class="muted small" id="feedStatus">${nextCursor ? "Loading more as you scroll..." : "End of feed."}</div>
      <div id="feedSentinel" style="height:1px"></div>
    </div>
    <script>
      (function(){
        const more = document.getElementById('feedMore');
        const sentinel = document.getElementById('feedSentinel');
        const list = document.getElementById('feedList');
        const status = document.getElementById('feedStatus');
        if (!more || !sentinel || !list || !status) return;

        let loading = false;

        async function loadMore(){
          const next = more.getAttribute('data-next') || '';
          const tab = more.getAttribute('data-tab') || 'feed';
          if (!next || loading) return;
          loading = true;
          status.textContent = 'Loading...';
          try{
            const resp = await fetch('${base}/feed/more?tab=' + encodeURIComponent(tab) + '&cursor=' + encodeURIComponent(next), { credentials: 'same-origin' });
            const data = await resp.json();
            if (data && data.html) {
              const tmp = document.createElement('div');
              tmp.innerHTML = data.html;
              while(tmp.firstChild) list.appendChild(tmp.firstChild);
            }
            more.setAttribute('data-next', (data && data.nextCursor) ? data.nextCursor : '');
            status.textContent = (data && data.nextCursor) ? 'Loading more as you scroll...' : 'End of feed.';
          }catch(e){
            status.textContent = 'Could not load more.';
          }finally{
            loading = false;
          }
        }

        const io = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) loadMore();
          });
        }, { root: null, rootMargin: '600px', threshold: 0 });

        io.observe(sentinel);
      })();
    </script>
  `;

  const composerHtml =
    tab === "feed"
      ? `
        <div class="composer">
          <div class="composerTop">
            <a class="composerFake" href="${newPostHref}">Share something...</a>
            <a class="iconBtn" href="${newPostHref}" aria-label="Add photo or video">＋</a>
          </div>
          <div class="muted small help">500 characters max. Media optional. Up to ${MAX_MEDIA_FILES} files.</div>
          ${renderTabs({ base, active: tab })}
        </div>
      `
      : `
        <div class="composer">
          <div style="font-weight:900">${escapeHtml(bucketLabel(tab))}</div>
          <div class="muted small help">Use the dedicated page to post in this bucket.</div>
          ${renderTabs({ base, active: tab })}
          <div class="row" style="margin-top:10px">
            <a class="btn" href="${base}/${tab === "collection" ? "collection" : "trades"}">Go to ${escapeHtml(bucketLabel(tab))} page</a>
          </div>
        </div>
      `;

  return res.type("html").send(
    page(
      `
        <div class="stack">
          <div class="brandBar">
            <img class="brandLogo" src="${GOLD_NUGGET_LOGO_URL}" alt="Gold Nugget" />
          </div>

          ${composerHtml}

          ${postsHtml}
          ${moreBlock}
        </div>
      `,
      req
    )
  );
});

/** Feed endless loader (bucket-aware) */
proxy.get("/feed/more", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).json({ html: "", nextCursor: "" });
  if (!pool) return res.status(200).json({ html: "", nextCursor: "" });

  const tab = normalizeBucket(typeof req.query.tab === "string" ? req.query.tab : "feed");
  const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : "");

  const { posts, nextCursor } = await listBucketPostsWithMeta({
    shop,
    viewerCustomerId: viewerId,
    bucket: tab,
    limit: 15,
    cursor,
  });

  const html = posts
    .map((p) =>
      renderPostCard({
        post: p,
        base,
        viewerId,
        showAuthorLink: true,
        returnPath: `${base}?tab=${tab}`,
      })
    )
    .join("");

  return res.status(200).json({ html, nextCursor: nextCursor || "" });
});

/** Like toggle */
proxy.post("/posts/:id/like", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect(base);

  const returnPath = cleanText(req.body?.return, 300);
  const fallback =
    req.headers.referer && String(req.headers.referer).includes("/proxy") ? req.headers.referer : `${base}`;

  try {
    await toggleLike({ shop, postId: id, customerId: viewerId });
    if (returnPath && returnPath.startsWith("/")) return res.redirect(returnPath + `#post-${id}`);
    return res.redirect(fallback + `#post-${id}`);
  } catch (e) {
    console.error("like error:", e);
    return res.redirect(fallback + `#post-${id}`);
  }
});

/** Add comment */
proxy.post("/posts/:id/comment", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect(base);

  const body = cleanMultiline(req.body?.comment, 300);
  const returnPath = cleanText(req.body?.return, 300);
  const fallback =
    req.headers.referer && String(req.headers.referer).includes("/proxy") ? req.headers.referer : `${base}`;

  if (!body) return res.redirect(fallback + `#post-${id}`);

  try {
    await addComment({ shop, postId: id, customerId: viewerId, body });
    if (returnPath && returnPath.startsWith("/")) return res.redirect(returnPath + `#post-${id}`);
    return res.redirect(fallback + `#post-${id}`);
  } catch (e) {
    console.error("comment error:", e);
    return res.redirect(fallback + `#post-${id}`);
  }
});

/** My Profile */
proxy.get("/me", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  await ensureRow(viewerId, shop);

  const profile = await getProfile(viewerId);
  const displayName = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Name not set";

  const handle = safeHandle(profile?.username);
  const handleLine = handle
    ? `<div class="muted handleUnder">${escapeHtml(handle)}</div>`
    : `<div class="muted handleUnder">Username not set</div>`;

  const avatarSrc = `${base}/me/avatar`;
  const editHref = `${base}/me/edit`;

  const newPostHref = `${base}/post/new?return=me&bucket=feed`;

  const collectionHref = `${base}/collection`;
  const tradesHref = `${base}/trades`;

  const { posts } = await listPostsForCustomerWithMeta({
    targetCustomerId: viewerId,
    viewerCustomerId: viewerId,
    limit: 20,
  });

  const postsHtml =
    posts.length === 0
      ? `<div class="postList"><p class="muted">No posts yet.</p></div>`
      : `<div class="postList">
          ${posts
            .map((p) =>
              renderPostCard({ post: p, base, viewerId, showAuthorLink: false, returnPath: `${base}/me` })
            )
            .join("")}
        </div>`;

  return res.type("html").send(
    page(
      `
        <div class="profileTop">
          <div class="avatarWrap">
            <div class="avatarBox">
              <img class="avatar" src="${avatarSrc}" alt="Profile photo" />
              <a class="avatarEdit" href="${editHref}" aria-label="Edit profile">✎</a>
            </div>

            <div class="nameUnder">${escapeHtml(displayName)}</div>
            ${handleLine}

            <div class="composer">
              <div class="composerTop">
                <a class="composerFake" href="${newPostHref}">Share something...</a>
                <a class="iconBtn" href="${newPostHref}" aria-label="Add photo or video">＋</a>
              </div>
              <div class="muted small help">500 characters max. Media optional. Up to ${MAX_MEDIA_FILES} files.</div>
            </div>

            <div class="collectionsRow">
              <a class="collectionCard" href="${collectionHref}" aria-label="Go to Collection">
                <div>
                  <div class="collectionTitle">Collection</div>
                  <div class="muted small">Collection bucket posts</div>
                </div>
                <div class="chev">›</div>
              </a>

              <a class="collectionCard" href="${tradesHref}" aria-label="Go to Trades">
                <div>
                  <div class="collectionTitle">Trades</div>
                  <div class="muted small">Trades bucket posts</div>
                </div>
                <div class="chev">›</div>
              </a>
            </div>

            ${postsHtml}
          </div>
        </div>
      `,
      req
    )
  );
});

/** Public profile: /u/:customerId (feed-only posts, no composer) */
proxy.get("/u/:customerId", async (req, res) => {
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  const targetId = String(req.params.customerId || "").trim();
  if (!targetId) return res.type("html").send(page(`<p class="error">Missing user.</p>`, req));

  if (viewerId && targetId === viewerId) return res.redirect(`${base}/me`);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  const profile = await getProfile(targetId);
  if (!profile) return res.type("html").send(page(`<p class="error">User not found.</p>`, req));

  const displayName = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Name not set";
  const handle = safeHandle(profile?.username);
  const handleLine = handle
    ? `<div class="muted handleUnder">${escapeHtml(handle)}</div>`
    : `<div class="muted handleUnder">Username not set</div>`;

  const ini = initialsFor(profile?.first_name || "", profile?.last_name || "");
  const avatarSvg = svgAvatar(ini);

  const { posts } = await listPostsForCustomerWithMeta({
    targetCustomerId: targetId,
    viewerCustomerId: viewerId,
    limit: 20,
  });

  const postsHtml =
    posts.length === 0
      ? `<div class="postList"><p class="muted">No posts yet.</p></div>`
      : `<div class="postList">
          ${posts
            .map((p) =>
              renderPostCard({
                post: p,
                base,
                viewerId,
                showAuthorLink: false,
                returnPath: `${base}/u/${encodeURIComponent(targetId)}`,
              })
            )
            .join("")}
        </div>`;

  return res.type("html").send(
    page(
      `
        <div class="profileTop">
          <div class="avatarWrap">
            <div class="avatarBox">
              <img class="avatar" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg)}" alt="Profile photo" />
            </div>

            <div class="nameUnder">${escapeHtml(displayName)}</div>
            ${handleLine}

            ${postsHtml}
          </div>
        </div>
      `,
      req
    )
  );
});

/** Collection page (bucket=collection only, required media, two-column grid) */
proxy.get("/collection", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>Please log in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  await ensureRow(viewerId, shop);

  const { posts, nextCursor } = await listBucketPostsWithMeta({
    shop,
    viewerCustomerId: viewerId,
    bucket: "collection",
    limit: 24,
    cursor: null,
  });

  const gridHtml =
    posts.length === 0
      ? `<p class="muted">No collection posts yet.</p>`
      : `<div class="bucketGrid" id="bucketList">
          ${posts
            .map((p) =>
              renderPostCard({
                post: p,
                base,
                viewerId,
                showAuthorLink: true,
                returnPath: `${base}/collection`,
              })
            )
            .join("")}
        </div>`;

  const moreBlock = `
    <div class="divider"></div>
    <div id="bucketMore" data-next="${escapeHtml(nextCursor || "")}">
      <div class="muted small" id="bucketStatus">${nextCursor ? "Loading more as you scroll..." : "End of posts."}</div>
      <div id="bucketSentinel" style="height:1px"></div>
    </div>
    <script>
      (function(){
        const more = document.getElementById('bucketMore');
        const sentinel = document.getElementById('bucketSentinel');
        const list = document.getElementById('bucketList');
        const status = document.getElementById('bucketStatus');
        if (!more || !sentinel || !list || !status) return;

        let loading = false;

        async function loadMore(){
          const next = more.getAttribute('data-next') || '';
          if (!next || loading) return;
          loading = true;
          status.textContent = 'Loading...';
          try{
            const resp = await fetch('${base}/bucket/more?bucket=collection&cursor=' + encodeURIComponent(next), { credentials: 'same-origin' });
            const data = await resp.json();
            if (data && data.html) {
              const tmp = document.createElement('div');
              tmp.innerHTML = data.html;
              while(tmp.firstChild) list.appendChild(tmp.firstChild);
            }
            more.setAttribute('data-next', (data && data.nextCursor) ? data.nextCursor : '');
            status.textContent = (data && data.nextCursor) ? 'Loading more as you scroll...' : 'End of posts.';
          }catch(e){
            status.textContent = 'Could not load more.';
          }finally{
            loading = false;
          }
        }

        const io = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) loadMore();
          });
        }, { root: null, rootMargin: '600px', threshold: 0 });

        io.observe(sentinel);
      })();
    </script>
  `;

  return res.type("html").send(
    page(
      `
        <div class="stack">
          <div style="font-weight:900;font-size:18px">My Collection</div>
          ${renderInlineBucketComposer({ base, bucket: "collection", returnTo: `${base}/collection`, requireMedia: true })}
          ${gridHtml}
          ${moreBlock}
        </div>
      `,
      req
    )
  );
});

/** Trades page (bucket=trades only, required media, two-column grid) */
proxy.get("/trades", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>Please log in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  await ensureRow(viewerId, shop);

  const { posts, nextCursor } = await listBucketPostsWithMeta({
    shop,
    viewerCustomerId: viewerId,
    bucket: "trades",
    limit: 24,
    cursor: null,
  });

  const gridHtml =
    posts.length === 0
      ? `<p class="muted">No trade posts yet.</p>`
      : `<div class="bucketGrid" id="bucketList">
          ${posts
            .map((p) =>
              renderPostCard({
                post: p,
                base,
                viewerId,
                showAuthorLink: true,
                returnPath: `${base}/trades`,
              })
            )
            .join("")}
        </div>`;

  const moreBlock = `
    <div class="divider"></div>
    <div id="bucketMore" data-next="${escapeHtml(nextCursor || "")}">
      <div class="muted small" id="bucketStatus">${nextCursor ? "Loading more as you scroll..." : "End of posts."}</div>
      <div id="bucketSentinel" style="height:1px"></div>
    </div>
    <script>
      (function(){
        const more = document.getElementById('bucketMore');
        const sentinel = document.getElementById('bucketSentinel');
        const list = document.getElementById('bucketList');
        const status = document.getElementById('bucketStatus');
        if (!more || !sentinel || !list || !status) return;

        let loading = false;

        async function loadMore(){
          const next = more.getAttribute('data-next') || '';
          if (!next || loading) return;
          loading = true;
          status.textContent = 'Loading...';
          try{
            const resp = await fetch('${base}/bucket/more?bucket=trades&cursor=' + encodeURIComponent(next), { credentials: 'same-origin' });
            const data = await resp.json();
            if (data && data.html) {
              const tmp = document.createElement('div');
              tmp.innerHTML = data.html;
              while(tmp.firstChild) list.appendChild(tmp.firstChild);
            }
            more.setAttribute('data-next', (data && data.nextCursor) ? data.nextCursor : '');
            status.textContent = (data && data.nextCursor) ? 'Loading more as you scroll...' : 'End of posts.';
          }catch(e){
            status.textContent = 'Could not load more.';
          }finally{
            loading = false;
          }
        }

        const io = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) loadMore();
          });
        }, { root: null, rootMargin: '600px', threshold: 0 });

        io.observe(sentinel);
      })();
    </script>
  `;

  return res.type("html").send(
    page(
      `
        <div class="stack">
          <div style="font-weight:900;font-size:18px">Trades</div>
          ${renderInlineBucketComposer({ base, bucket: "trades", returnTo: `${base}/trades`, requireMedia: true })}
          ${gridHtml}
          ${moreBlock}
        </div>
      `,
      req
    )
  );
});

/** Bucket endless loader (collection/trades) */
proxy.get("/bucket/more", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).json({ html: "", nextCursor: "" });
  if (!pool) return res.status(200).json({ html: "", nextCursor: "" });

  const bucket = normalizeBucket(typeof req.query.bucket === "string" ? req.query.bucket : "feed");
  const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : "");

  const { posts, nextCursor } = await listBucketPostsWithMeta({
    shop,
    viewerCustomerId: viewerId,
    bucket,
    limit: 24,
    cursor,
  });

  const returnPath =
    bucket === "collection" ? `${base}/collection` : bucket === "trades" ? `${base}/trades` : `${base}`;
  const html = posts
    .map((p) => renderPostCard({ post: p, base, viewerId, showAuthorLink: true, returnPath }))
    .join("");

  return res.status(200).json({ html, nextCursor: nextCursor || "" });
});

/** New post page (feed bucket only via this UI; supports multi-media) */
proxy.get("/post/new", async (req, res) => {
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  const r = typeof req.query.return === "string" ? req.query.return : "feed";
  const returnTo =
    r === "me" ? `${base}/me` : r === "feed" ? `${base}?tab=feed` : r.startsWith("/") ? r : `${base}`;

  const bucket = normalizeBucket(typeof req.query.bucket === "string" ? req.query.bucket : "feed");
  const requireMedia = bucket !== "feed";

  const status =
    req.query.err === "1"
      ? `<p class="error">Add text or media.</p>`
      : req.query.type === "1"
      ? `<p class="error">Unsupported file type.</p>`
      : req.query.media === "1"
      ? `<p class="error">Media is required for this post.</p>`
      : "";

  const postAction = `${base}/post/new`;
  const cancelHref = returnTo;

  return res.type("html").send(
    page(
      `
        ${status}
        <div class="stack">
          <form method="POST" enctype="multipart/form-data" action="${postAction}">
            <input type="hidden" name="return" value="${escapeHtml(returnTo)}" />
            <input type="hidden" name="bucket" value="${escapeHtml(bucket)}" />

            <label for="body">Post</label>
            <textarea id="body" name="body" maxlength="500" placeholder="Write your post (max 500 characters)"></textarea>
            <div class="muted small help">0 to 500 characters.</div>

            <label for="media">Photo or video ${requireMedia ? "(required)" : "(optional)"}</label>
            <input id="media" type="file" name="media" ${requireMedia ? "required" : ""} multiple accept="image/*,video/*" />
            <div class="muted small help">Up to ${MAX_MEDIA_FILES} files. 15MB max per file.</div>

            <div class="row">
              <button class="btn" type="submit" id="sendBtn">Send</button>
              <a class="btn" href="${cancelHref}">Cancel</a>
            </div>
          </form>
        </div>

        <script>
          (function(){
            const ta = document.getElementById('body');
            const media = document.getElementById('media');
            const btn = document.getElementById('sendBtn');
            const requireMedia = ${requireMedia ? "true" : "false"};
            function update(){
              const hasText = ta && ta.value && ta.value.trim().length > 0;
              const hasMedia = media && media.files && media.files.length > 0;
              const ok = requireMedia ? hasMedia : (hasText || hasMedia);
              btn.disabled = !ok;
              btn.style.opacity = btn.disabled ? '0.5' : '1';
              btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
            }
            if (ta) ta.addEventListener('input', update);
            if (media) media.addEventListener('change', update);
            update();
          })();
        </script>
      `,
      req
    )
  );
});

/** Create post (multi-media, bucket-aware, required media for non-feed buckets) */
proxy.post("/post/new", uploadPostMedia.array("media", MAX_MEDIA_FILES), async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const bucket = normalizeBucket(req.body?.bucket);
  const requireMedia = bucket !== "feed";

  const body = cleanMultiline(req.body?.body, 500);

  const files = Array.isArray(req.files) ? req.files : [];
  const mediaItems = [];

  for (const f of files) {
    if (!f || !f.buffer || !f.mimetype) continue;
    if (!allowedMediaMime(f.mimetype)) return res.redirect(`${base}/post/new?type=1`);
    mediaItems.push({ bytes: f.buffer, mime: f.mimetype });
  }

  const hasText = !!(body && body.trim());
  const hasMedia = mediaItems.length > 0;

  if (requireMedia && !hasMedia) {
    const ret = cleanText(req.body?.return, 300);
    const back = ret && ret.startsWith("/") ? ret : `${base}`;
    return res.redirect(back + (back.includes("?") ? "&" : "?") + "media=1");
  }

  if (!requireMedia && !hasText && !hasMedia) {
    return res.redirect(`${base}/post/new?err=1`);
  }

  const returnToRaw = cleanText(req.body?.return, 300);
  const returnTo = returnToRaw && returnToRaw.startsWith("/") ? returnToRaw : `${base}`;

  try {
    await ensureRow(viewerId, shop);
    const postId = await createPost({ shop, customerId: viewerId, body, bucket });
    if (!postId) return res.redirect(`${base}/post/new?err=1`);

    if (hasMedia) {
      await addPostMedia(postId, mediaItems);
    }

    return res.redirect(returnTo);
  } catch (e) {
    console.error("create post error:", e);
    return res.redirect(`${base}/post/new?err=1`);
  }
});

/** Edit profile */
proxy.get("/me/edit", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, req));
  }
  if (!pool) {
    return res.type("html").send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, req));
  }

  await ensureRow(viewerId, shop);

  const profile = await getProfile(viewerId);
  const first = profile?.first_name || "";
  const last = profile?.last_name || "";
  const bio = profile?.bio || "";
  const social_url = profile?.social_url || "";

  const avatarSrc = `${base}/me/avatar`;
  const saveAction = `${base}/me/edit`;
  const avatarAction = `${base}/me/avatar`;
  const doneHref = `${base}/me`;

  return res.type("html").send(
    page(
      `
        <div class="profileTop">
          <div class="avatarWrap">
            <div class="avatarBox">
              <img class="avatar" src="${avatarSrc}" alt="Profile photo" />

              <form id="avatarForm" method="POST" enctype="multipart/form-data" action="${avatarAction}">
                <input id="avatarInput" class="fileInput" type="file" name="avatar" accept="image/png,image/jpeg,image/webp" />
              </form>

              <button class="avatarEdit" type="button" id="avatarBtn" aria-label="Change profile photo">✎</button>
            </div>

            <div class="help small muted">Tap ✎ to change photo</div>
          </div>

          <div class="stack">
            <form method="POST" action="${saveAction}">
              <label for="first_name">First name</label>
              <input id="first_name" name="first_name" value="${escapeHtml(first)}" required />

              <label for="last_name">Last name</label>
              <input id="last_name" name="last_name" value="${escapeHtml(last)}" required />

              <label for="social_url">Social link</label>
              <input id="social_url" name="social_url" value="${escapeHtml(social_url)}" placeholder="https://instagram.com/yourname" />

              <label for="bio">Bio</label>
              <textarea id="bio" name="bio" maxlength="500" placeholder="Tell the community about you...">${escapeHtml(bio)}</textarea>

              <div class="row">
                <button class="btn" type="submit">Save</button>
                <a class="btn" href="${doneHref}">Done</a>
              </div>

              <div class="muted small help">Photo max 2MB. PNG, JPG, or WEBP.</div>
            </form>
          </div>
        </div>

        <script>
          (function(){
            const btn = document.getElementById('avatarBtn');
            const input = document.getElementById('avatarInput');
            const form = document.getElementById('avatarForm');
            if (!btn || !input || !form) return;
            btn.addEventListener('click', () => input.click());
            input.addEventListener('change', () => {
              if (!input.files || !input.files[0]) return;
              form.submit();
            });
          })();
        </script>
      `,
      req
    )
  );
});

proxy.post("/me/edit", async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const first_name = cleanText(req.body?.first_name, 40);
  const last_name = cleanText(req.body?.last_name, 40);
  const social_url = cleanText(req.body?.social_url, 220);
  const bio = cleanMultiline(req.body?.bio, 500);

  try {
    await ensureRow(viewerId, shop);
    await updateProfile(viewerId, { first_name, last_name, social_url, bio });
    return res.redirect(`${base}/me/edit`);
  } catch (e) {
    console.error("edit save error:", e);
    return res.redirect(`${base}/me/edit`);
  }
});

proxy.post("/me/avatar", uploadAvatar.single("avatar"), async (req, res) => {
  const shop = getShop(req);
  const viewerId = getViewerCustomerId(req);
  const base = basePathFromReq(req);

  if (!viewerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const file = req.file;
  if (!file || !file.buffer || !file.mimetype) return res.redirect(`${base}/me/edit`);

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.mimetype)) return res.redirect(`${base}/me/edit`);

  try {
    await ensureRow(viewerId, shop);
    await updateProfile(viewerId, { avatar_bytes: file.buffer, avatar_mime: file.mimetype });
    return res.redirect(`${base}/me/edit`);
  } catch (e) {
    console.error("avatar upload error:", e);
    return res.redirect(`${base}/me/edit`);
  }
});

app.use("/proxy", proxy);

app.use((req, res) => res.status(404).type("text").send("Not found"));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
