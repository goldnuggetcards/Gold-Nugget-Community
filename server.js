// server.js (FULL FILE REPLACEMENT)
// Goal: keep it simple and make navigation work reliably.
// - Clicking the edit icon on /me goes to /me/edit
// - Clicking Done on /me/edit goes back to /me
// Implementation detail:
// - Do NOT carry forward the signed querystring in links/forms/images
// - Use Shopify’s `path_prefix` to build links (falls back to /apps/nuggetdepot)

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

async function ensureSchema() {
  if (!pool) return;

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

  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT ''`);

  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS social_url TEXT NOT NULL DEFAULT ''`);

  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_bytes BYTEA`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_mime TEXT NOT NULL DEFAULT ''`);

  // Backfill NULLs for older schemas
  await pool.query(`UPDATE profiles_v2 SET username = '' WHERE username IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET full_name = '' WHERE full_name IS NULL`);
  await pool.query(`UPDATE profiles_v2 SET favorite_pokemon = '' WHERE favorite_pokemon IS NULL`);
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

function requireProxyAuth(req, res, next) {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";

  if (!SHOPIFY_API_SECRET) {
    return res.status(200).type("html").send(
      page("", `<p class="error">Missing SHOPIFY_API_SECRET</p>`, shop, true, req)
    );
  }

  if (!verifyShopifyProxy(req)) {
    const keys = Object.keys(req.query || {}).sort().join(", ");
    return res.status(200).type("html").send(
      page(
        "",
        `
          <p class="error">Invalid proxy signature.</p>
          <p class="muted">Path: <code>${req.originalUrl}</code></p>
          <p class="muted">Query keys: <code>${keys || "none"}</code></p>
        `,
        shop,
        true,
        req
      )
    );
  }

  return next();
}

function basePathFromReq(req) {
  const p = typeof req.query.path_prefix === "string" ? req.query.path_prefix : "";
  return p && p.startsWith("/") ? p : "/apps/nuggetdepot";
}

function page(_title, bodyHtml, shop, nav = true, reqForBase = null) {
  const safeShop = shop || "unknown";
  const base = reqForBase ? basePathFromReq(reqForBase) : "/apps/nuggetdepot";

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
      input, textarea{padding:10px 12px;border:1px solid #ddd;border-radius:10px;width:100%;max-width:520px;font:inherit}
      textarea{min-height:110px;resize:vertical}
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
      .stack{width:100%;max-width:520px}
      .help{margin-top:6px}
    </style>
  </head>
  <body>
    ${nav ? `
    <div class="nav">
      <a href="${base}">Feed</a>
      <a href="${base}/me">My Profile</a>
      <a href="${base}/collection">My Collection</a>
      <a href="${base}/trades">Trades</a>
    </div>
    <hr/>` : ``}
    <div class="card">
      ${bodyHtml}
      <p class="muted">Shop: <code>${safeShop}</code></p>
    </div>
  </body>
</html>`;
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

/** Feed */
proxy.get("/", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    return res.type("html").send(
      page("", `<p>Please log in.</p><a class="btn" href="/account/login">Log in</a>`, shop, true, req)
    );
  }

  return res.type("html").send(
    page("", `<p>Feed placeholder.</p>`, shop, true, req)
  );
});

/** Avatar */
proxy.get("/me/avatar", async (req, res) => {
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
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

/** My Profile */
proxy.get("/me", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) {
    return res.type("html").send(
      page("", `<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, true, req)
    );
  }
  if (!pool) {
    return res.type("html").send(
      page("", `<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, true, req)
    );
  }

  await ensureRow(customerId, shop);

  const profile = await getProfile(customerId);
  const displayName = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Name not set";

  const handle = safeHandle(profile?.username);
  const handleLine = handle
    ? `<div class="muted handleUnder">${handle}</div>`
    : `<div class="muted handleUnder">Username not set</div>`;

  const avatarSrc = `${base}/me/avatar`;
  const editHref = `${base}/me/edit`;

  return res.type("html").send(
    page(
      "",
      `
        <div class="profileTop">
          <div class="avatarWrap">
            <div class="avatarBox">
              <img class="avatar" src="${avatarSrc}" alt="Profile photo" />
              <a class="avatarEdit" href="${editHref}" aria-label="Edit profile">✎</a>
            </div>

            <div class="nameUnder">${displayName}</div>
            ${handleLine}
          </div>
        </div>
      `,
      shop,
      true,
      req
    )
  );
});

/** Edit */
proxy.get("/me/edit", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) {
    return res.type("html").send(
      page("", `<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop, true, req)
    );
  }
  if (!pool) {
    return res.type("html").send(
      page("", `<p class="error">DATABASE_URL not set. Add it on Render.</p>`, shop, true, req)
    );
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
      "",
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
              <input id="first_name" name="first_name" value="${first}" required />

              <label for="last_name">Last name</label>
              <input id="last_name" name="last_name" value="${last}" required />

              <label for="social_url">Social link</label>
              <input id="social_url" name="social_url" value="${social_url}" placeholder="https://instagram.com/yourname" />

              <label for="bio">Bio</label>
              <textarea id="bio" name="bio" placeholder="Tell the community about you...">${bio}</textarea>

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
      true,
      req
    )
  );
});

proxy.post("/me/edit", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const base = basePathFromReq(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const first_name = cleanText(req.body?.first_name, 40);
  const last_name = cleanText(req.body?.last_name, 40);
  const social_url = cleanText(req.body?.social_url, 220);
  const bio = cleanMultiline(req.body?.bio, 500);

  if (!first_name || !last_name) return res.redirect(`${base}/me/edit`);

  try {
    await ensureRow(customerId, shop);
    await updateProfile(customerId, { first_name, last_name, social_url, bio });
    return res.redirect(`${base}/me/edit`);
  } catch (e) {
    console.error("edit save error:", e);
    return res.redirect(`${base}/me/edit`);
  }
});

proxy.post("/me/avatar", upload.single("avatar"), async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
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
  res.type("html").send(page("", `<p>Collection placeholder.</p>`, shop, true, req));
});

proxy.get("/trades", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page("", `<p>Trades placeholder.</p>`, shop, true, req));
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
