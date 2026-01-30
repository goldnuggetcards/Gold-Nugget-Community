// server.js (FULL FILE REPLACEMENT)
// Adds posting MVP:
// - Post entry point visible ONLY on /me (your own profile)
// - Clicking the box or media button goes to /post/new (more space)
// - 500 character max
// - Optional media (photo or video)
// - Send creates post and redirects back to /me
// - Public profile route /u/:customerId does NOT show the post box
// Notes:
// - Links/forms do NOT carry signed querystring
// - Uses Shopify path_prefix when available

import express from "express";
import crypto from "crypto";
import { Pool } from "pg";
import multer from "multer";

const app = express();
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${res.statusCode} ${req.method} ${req.originalUrl} (${ms}ms)`);
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

// Uploaders
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

const uploadPostMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB (MVP)
});

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

  // Posts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts_v1 (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      media_bytes BYTEA,
      media_mime TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN body SET DEFAULT ''`);
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN media_mime SET DEFAULT ''`);

  await pool.query(`UPDATE posts_v1 SET body = '' WHERE body IS NULL`);
  await pool.query(`UPDATE posts_v1 SET media_mime = '' WHERE media_mime IS NULL`);

  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN body SET NOT NULL`);
  await pool.query(`ALTER TABLE posts_v1 ALTER COLUMN media_mime SET NOT NULL`);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS posts_v1_customer_created_idx ON posts_v1 (customer_id, created_at DESC)`
  );
}

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
  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function basePathFromReq(req) {
  const p = typeof req.query.path_prefix === "string" ? req.query.path_prefix : "";
  return p && p.startsWith("/") ? p : "/apps/nuggetdepot";
}

function page(bodyHtml, shop, reqForBase) {
  const safeShop = shop || "unknown";
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
      .card{border:1px solid #ddd;border-radius:12px;padding:16px;max-width:860px}
      code{background:#f5f5f5;padding:2px 6px;border-radius:6px}
      .muted{opacity:.75}
      .btn{display:inline-block;margin-top:12px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;text-decoration:none;background:white;cursor:pointer}
      input, textarea{padding:10px 12px;border:1px solid #ddd;border-radius:10px;width:100%;max-width:720px;font:inherit}
      textarea{min-height:160px;resize:vertical}
      label{display:block;margin-top:12px;margin-bottom:6px}
      .error{color:#b00020}
      .ok{color:#137333}
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
      .stack{width:100%;max-width:720px}
      .help{margin-top:6px}

      .composer{
        width:100%;
        max-width:720px;
        border:1px solid #eee;
        border-radius:12px;
        padding:12px;
        margin-top:14px;
        background:#fff;
      }
      .composerTop{display:flex;gap:10px;align-items:center}
      .composerFake{
        flex:1;
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

      .postList{width:100%;max-width:720px;margin-top:14px}
      .postItem{border:1px solid #eee;border-radius:12px;padding:12px;margin-top:10px}
      .postMeta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .media{
        width:100%;
        max-width:100%;
        border-radius:12px;
        border:1px solid #eee;
        margin-top:10px;
        background:#fafafa;
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
      <p class="muted">Shop: <code>${safeShop}</code></p>
    </div>
  </body>
</html>`;
}

function requireProxyAuth(req, res, next) {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";

  if (!SHOPIFY_API_SECRET) {
    return res
      .status(200)
      .type("html")
      .send(page(`<p class="error">Missing SHOPIFY_API_SECRET</p>`, shop, req));
  }

  if (!verifyShopifyProxy(req)) {
    const keys = Object.keys(req.query || {}).sort().join(", ");
    return res.status(200).type("html").send(
      page(
        `
          <p class="error">Invalid proxy signature.</p>
          <p class="muted">Path: <code>${req.originalUrl}</code></p>
          <p class="muted">Query keys: <code>${keys || "none"}</code></p>
        `,
        shop,
        req
      )
    );
  }

  return next();
}

function cleanText(input, max = 80) {
  return String(input || "").trim().slice(0, max);
}
function cleanMultiline(input, max = 400) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
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
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

async function createPost({ shop, customerId, body, mediaBytes, mediaMime }) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  const r = await pool.query(
    `INSERT INTO posts_v1 (shop, customer_id, body, media_bytes, media_mime)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [shop, customerId, body || "", mediaBytes || null, mediaMime || ""]
  );
  return r.rows?.[0]?.id || null;
}

async function listPostsForCustomer(customerId, limit = 20) {
  if (!pool) return [];
  await ensureSchema();
  const r = await pool.query(
    `SELECT id, body, media_mime, created_at
     FROM posts_v1
     WHERE customer_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [customerId, limit]
  );
  return r.rows || [];
}

async function getPostMedia(postId) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(
    `SELECT media_bytes, media_mime FROM posts_v1 WHERE id=$1`,
    [postId]
  );
  return r.rows?.[0] || null;
}

/** Non-proxy root */
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

/** Proxy */
const proxy = express.Router();
proxy.use(requireProxyAuth);

/** Feed (placeholder) */
proxy.get("/", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    return res
      .type("html")
      .send(page(`<p>Please log in.</p><a class="btn" href="/account/login">Log in</a>`, shop, req));
  }

  return res.type("html").send(page(`<p>Feed placeholder.</p>`, shop, req));
});

/** Avatar */
proxy.get("/me/avatar", async (req, res) => {
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
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

/** Post media */
proxy.get("/posts/:id/media", async (req, res) => {
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).type("text").send("Not found");

  try {
    const m = await getPostMedia(id);
    if (!m?.media_bytes || !m?.media_mime) return res.status(404).type("text").send("Not found");

    res.setHeader("Content-Type", m.media_mime);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(m.media_bytes);
  } catch (e) {
    console.error("post media error:", e);
    return res.status(200).type("text").send("Media error");
  }
});

/** My Profile (shows post box ONLY here) */
proxy.get("/me", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, req));
  }
  if (!pool) {
    return res
      .type("html")
      .send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, req));
  }

  await ensureRow(customerId, shop);

  const profile = await getProfile(customerId);
  const displayName =
    `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Name not set";

  const handle = safeHandle(profile?.username);
  const handleLine = handle
    ? `<div class="muted handleUnder">${escapeHtml(handle)}</div>`
    : `<div class="muted handleUnder">Username not set</div>`;

  const avatarSrc = `${base}/me/avatar`;
  const editHref = `${base}/me/edit`;
  const newPostHref = `${base}/post/new`;

  const posts = await listPostsForCustomer(customerId, 20);

  const postsHtml =
    posts.length === 0
      ? `<div class="postList"><p class="muted">No posts yet.</p></div>`
      : `<div class="postList">
          ${posts
            .map((p) => {
              const body = escapeHtml(p.body || "");
              const hasMedia = !!(p.media_mime && p.media_mime.trim());
              const isVideo = hasMedia && p.media_mime.startsWith("video/");
              const mediaUrl = `${base}/posts/${p.id}/media`;

              const mediaHtml = !hasMedia
                ? ""
                : isVideo
                  ? `<video class="media" controls playsinline src="${mediaUrl}"></video>`
                  : `<img class="media" src="${mediaUrl}" alt="Post media" />`;

              const when = new Date(p.created_at).toLocaleString();

              return `
                <div class="postItem">
                  <div class="postMeta">
                    <span class="muted small">${escapeHtml(when)}</span>
                  </div>
                  ${body ? `<p style="margin:10px 0 0 0;white-space:pre-wrap">${body}</p>` : ""}
                  ${mediaHtml}
                </div>
              `;
            })
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
              <div class="muted small help">500 characters max. Media optional.</div>
            </div>

            ${postsHtml}
          </div>
        </div>
      `,
      shop,
      req
    )
  );
});

/** Public profile: /u/:customerId (no post box) */
proxy.get("/u/:customerId", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const viewerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  const targetId = String(req.params.customerId || "").trim();
  if (!targetId) return res.type("html").send(page(`<p class="error">Missing user.</p>`, shop, req));

  if (viewerId && targetId === viewerId) {
    return res.redirect(`${base}/me`);
  }

  if (!viewerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, req));
  }
  if (!pool) {
    return res
      .type("html")
      .send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, req));
  }

  const profile = await getProfile(targetId);
  if (!profile) {
    return res.type("html").send(page(`<p class="error">User not found.</p>`, shop, req));
  }

  const displayName =
    `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Name not set";
  const handle = safeHandle(profile?.username);
  const handleLine = handle
    ? `<div class="muted handleUnder">${escapeHtml(handle)}</div>`
    : `<div class="muted handleUnder">Username not set</div>`;

  // Avatar endpoint currently only supports "me", so use initials fallback for public view for now.
  // If you want public avatars, add /avatar/:customerId endpoint later.
  const ini = initialsFor(profile?.first_name || "", profile?.last_name || "");
  const avatarSvg = svgAvatar(ini);

  const posts = await listPostsForCustomer(targetId, 20);
  const postsHtml =
    posts.length === 0
      ? `<div class="postList"><p class="muted">No posts yet.</p></div>`
      : `<div class="postList">
          ${posts
            .map((p) => {
              const body = escapeHtml(p.body || "");
              const hasMedia = !!(p.media_mime && p.media_mime.trim());
              const isVideo = hasMedia && p.media_mime.startsWith("video/");
              const mediaUrl = `${base}/posts/${p.id}/media`;
              const mediaHtml = !hasMedia
                ? ""
                : isVideo
                  ? `<video class="media" controls playsinline src="${mediaUrl}"></video>`
                  : `<img class="media" src="${mediaUrl}" alt="Post media" />`;
              const when = new Date(p.created_at).toLocaleString();

              return `
                <div class="postItem">
                  <div class="postMeta">
                    <span class="muted small">${escapeHtml(when)}</span>
                  </div>
                  ${body ? `<p style="margin:10px 0 0 0;white-space:pre-wrap">${body}</p>` : ""}
                  ${mediaHtml}
                </div>
              `;
            })
            .join("")}
        </div>`;

  return res.type("html").send(
    page(
      `
        <div class="profileTop">
          <div class="avatarWrap">
            <div class="avatarBox">
              <img class="avatar" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                avatarSvg
              )}" alt="Profile photo" />
            </div>

            <div class="nameUnder">${escapeHtml(displayName)}</div>
            ${handleLine}

            ${postsHtml}
          </div>
        </div>
      `,
      shop,
      req
    )
  );
});

/** New post page */
proxy.get("/post/new", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, req));
  }
  if (!pool) {
    return res
      .type("html")
      .send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, req));
  }

  const status =
    req.query.err === "1"
      ? `<p class="error">Add text or media.</p>`
      : req.query.toobig === "1"
        ? `<p class="error">Media too large. Max 15MB.</p>`
        : req.query.type === "1"
          ? `<p class="error">Unsupported file type.</p>`
          : "";

  const postAction = `${base}/post/new`;
  const cancelHref = `${base}/me`;

  return res.type("html").send(
    page(
      `
        ${status}
        <div class="stack">
          <form method="POST" enctype="multipart/form-data" action="${postAction}">
            <label for="body">Post</label>
            <textarea id="body" name="body" maxlength="500" placeholder="Write your post (max 500 characters)"></textarea>
            <div class="muted small help">0 to 500 characters.</div>

            <label for="media">Photo or video</label>
            <input id="media" type="file" name="media" accept="image/*,video/*" />

            <div class="row">
              <button class="btn" type="submit" id="sendBtn">Send</button>
              <a class="btn" href="${cancelHref}">Cancel</a>
            </div>

            <div class="muted small help">Media max 15MB.</div>
          </form>
        </div>

        <script>
          (function(){
            const ta = document.getElementById('body');
            const btn = document.getElementById('sendBtn');
            function update(){
              const hasText = ta && ta.value && ta.value.trim().length > 0;
              btn.disabled = !hasText;
              btn.style.opacity = btn.disabled ? '0.5' : '1';
              btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
            }
            if (ta && btn) {
              ta.addEventListener('input', update);
              update();
            }
          })();
        </script>
      `,
      shop,
      req
    )
  );
});

/** Create post */
proxy.post("/post/new", uploadPostMedia.single("media"), async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const body = cleanMultiline(req.body?.body, 500);

  const file = req.file;
  let mediaBytes = null;
  let mediaMime = "";

  if (file && file.buffer && file.mimetype) {
    const allowed = new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ]);

    if (!allowed.has(file.mimetype)) {
      return res.redirect(`${base}/post/new?type=1`);
    }

    mediaBytes = file.buffer;
    mediaMime = file.mimetype;
  }

  const hasText = !!(body && body.trim());
  const hasMedia = !!mediaBytes;

  if (!hasText && !hasMedia) {
    return res.redirect(`${base}/post/new?err=1`);
  }

  try {
    await ensureRow(customerId, shop);
    await createPost({ shop, customerId, body, mediaBytes, mediaMime });
    return res.redirect(`${base}/me`);
  } catch (e) {
    console.error("create post error:", e);
    return res.redirect(`${base}/post/new?err=1`);
  }
});

/** Edit profile (existing) */
proxy.get("/me/edit", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) {
    return res
      .type("html")
      .send(page(`<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, req));
  }
  if (!pool) {
    return res
      .type("html")
      .send(page(`<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, req));
  }

  await ensureRow(customerId, shop);

  const profile = await getProfile(customerId);
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
                <input
                  id="avatarInput"
                  class="fileInput"
                  type="file"
                  name="avatar"
                  accept="image/png,image/jpeg,image/webp"
                />
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
              <input id="social_url" name="social_url" value="${escapeHtml(
                social_url
              )}" placeholder="https://instagram.com/yourname" />

              <label for="bio">Bio</label>
              <textarea id="bio" name="bio" maxlength="500" placeholder="Tell the community about you...">${escapeHtml(
                bio
              )}</textarea>

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
      shop,
      req
    )
  );
});

proxy.post("/me/edit", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const first_name = cleanText(req.body?.first_name, 40);
  const last_name = cleanText(req.body?.last_name, 40);
  const social_url = cleanText(req.body?.social_url, 220);
  const bio = cleanMultiline(req.body?.bio, 500);

  try {
    await ensureRow(customerId, shop);
    await updateProfile(customerId, { first_name, last_name, social_url, bio });
    return res.redirect(`${base}/me/edit`);
  } catch (e) {
    console.error("edit save error:", e);
    return res.redirect(`${base}/me/edit`);
  }
});

proxy.post("/me/avatar", uploadAvatar.single("avatar"), async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const file = req.file;
  if (!file || !file.buffer || !file.mimetype) return res.redirect(`${base}/me/edit`);

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.mimetype)) return res.redirect(`${base}/me/edit`);

  try {
    await ensureRow(customerId, shop);
    await updateProfile(customerId, { avatar_bytes: file.buffer, avatar_mime: file.mimetype });
    return res.redirect(`${base}/me/edit`);
  } catch (e) {
    console.error("avatar upload error:", e);
    return res.redirect(`${base}/me/edit`);
  }
});

proxy.get("/collection", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page(`<p>Collection placeholder.</p>`, shop, req));
});

proxy.get("/trades", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page(`<p>Trades placeholder.</p>`, shop, req));
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
