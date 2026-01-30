import express from "express";
import crypto from "crypto";
import { Pool } from "pg";
import multer from "multer";

const app = express();
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false }));

// Status + timing logger (helps diagnose Shopify proxy errors)
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

// Multer in-memory uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

async function ensureSchema() {
  if (!pool) return;

  // Base table
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

  // Add fields we need for profile display
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT ''`);

  // Avatar stored in DB (MVP)
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_bytes BYTEA`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS avatar_mime TEXT NOT NULL DEFAULT ''`);

  // Keep older columns safe (no-op if already present)
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS dob DATE`);
  await pool.query(`ALTER TABLE profiles_v2 ADD COLUMN IF NOT EXISTS favorite_pokemon TEXT NOT NULL DEFAULT ''`);
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

function page(title, bodyHtml, shop, nav = true) {
  const safeShop = shop || "unknown";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;line-height:1.35}
      a{color:inherit}
      .nav a{margin-right:12px}
      .card{border:1px solid #ddd;border-radius:12px;padding:16px;max-width:860px}
      code{background:#f5f5f5;padding:2px 6px;border-radius:6px}
      .muted{opacity:.75}
      .grid{display:grid;grid-template-columns:180px 1fr;gap:8px 16px;margin-top:12px}
      .k{opacity:.75}
      .btn{display:inline-block;margin-top:12px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;text-decoration:none;background:white;cursor:pointer}
      input{padding:10px 12px;border:1px solid #ddd;border-radius:10px;width:320px;max-width:100%}
      label{display:block;margin-top:12px;margin-bottom:6px}
      .error{color:#b00020}
      .ok{color:#137333}
      hr{border:none;border-top:1px solid #eee;margin:12px 0}
      .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .center{max-width:520px}
      .profileTop{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
      .avatarWrap{width:120px}
      .avatar{
        width:120px;height:120px;
        border-radius:16px;
        object-fit:cover;
        aspect-ratio:1/1;
        border:1px solid #ddd;
        background:#fafafa;
        display:block;
      }
      .nameUnder{margin-top:10px;font-weight:700}
      .subUnder{margin-top:2px}
      .small{font-size:13px}
    </style>
  </head>
  <body>
    ${nav ? `
    <div class="nav">
      <a href="/apps/nuggetdepot">Feed</a>
      <a href="/apps/nuggetdepot/me">My Profile</a>
      <a href="/apps/nuggetdepot/collection">My Collection</a>
      <a href="/apps/nuggetdepot/trades">Trades</a>
    </div>
    <hr/>` : ``}
    <div class="card ${nav ? "" : "center"}">
      <h1>${title}</h1>
      ${bodyHtml}
      <p class="muted">Shop: <code>${safeShop}</code></p>
    </div>
  </body>
</html>`;
}

// Return HTML on auth failure so Shopify does not show the generic third party error page
function requireProxyAuth(req, res, next) {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";

  if (!SHOPIFY_API_SECRET) {
    return res.status(200).type("html").send(
      page(
        "Config error",
        `<p class="error">Missing SHOPIFY_API_SECRET</p>`,
        shop
      )
    );
  }

  if (!verifyShopifyProxy(req)) {
    const keys = Object.keys(req.query || {}).sort().join(", ");
    return res.status(200).type("html").send(
      page(
        "Proxy auth failed",
        `
          <p class="error">Invalid proxy signature.</p>
          <p class="muted">Path: <code>${req.originalUrl}</code></p>
          <p class="muted">Query keys: <code>${keys || "none"}</code></p>
          <p class="muted small">If this page appears, Shopify is reaching your server but the proxy signature check is failing.</p>
        `,
        shop
      )
    );
  }

  return next();
}

function signedQueryString(req) {
  return new URLSearchParams(req.query).toString();
}

function cleanText(input, max = 80) {
  return String(input || "").trim().slice(0, max);
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

async function getProfile(customerId) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(
    `SELECT customer_id, shop, username, full_name, dob, favorite_pokemon,
            first_name, last_name, avatar_mime
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
    `INSERT INTO profiles_v2 (customer_id, shop)
     VALUES ($1,$2)
     ON CONFLICT (customer_id) DO UPDATE SET shop=EXCLUDED.shop, updated_at=NOW()`,
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

/** FEED (placeholder) */
proxy.get("/", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    return res.type("html").send(
      page(
        "Nugget Depot",
        `<p>Please log in to view the community feed.</p>
         <a class="btn" href="/account/login">Log in</a>`,
        shop
      )
    );
  }

  return res.type("html").send(
    page(
      "Community Feed",
      `<p>Feed placeholder.</p>
       <p class="muted">Next: posts table, image uploads, likes/comments.</p>`,
      shop
    )
  );
});

/** Avatar image endpoint (img src must include signed query string) */
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

/** PROFILE PAGE */
proxy.get("/me", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const qs = signedQueryString(req);

  if (!customerId) {
    return res.type("html").send(
      page(
        "My Profile",
        `<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`,
        shop
      )
    );
  }

  if (!pool) {
    return res.type("html").send(
      page(
        "My Profile",
        `<p class="error">DATABASE_URL not set. Add it on Render.</p>`,
        shop
      )
    );
  }

  await ensureRow(customerId, shop);

  const profile = await getProfile(customerId);
  const first = profile?.first_name || "";
  const last = profile?.last_name || "";
  const displayName = `${first} ${last}`.trim() || "Name not set";

  const status =
    req.query.saved === "1"
      ? `<p class="ok">Saved.</p>`
      : req.query.err === "1"
        ? `<p class="error">Please check your inputs.</p>`
        : req.query.imgerr === "1"
          ? `<p class="error">Upload a PNG, JPG, or WEBP under 2MB.</p>`
          : "";

  const avatarSrc = `/apps/nuggetdepot/me/avatar?${qs}`;

  return res.type("html").send(
    page(
      "My Profile",
      `
        ${status}

        <div class="profileTop">
          <div class="avatarWrap">
            <img class="avatar" src="${avatarSrc}" alt="Profile photo" />
            <div class="nameUnder">${displayName}</div>
            <div class="muted subUnder small">Community profile</div>
          </div>

          <div style="min-width:260px;flex:1">
            <div class="grid">
              <div class="k">Customer ID</div><div><code>${customerId}</code></div>
              <div class="k">Username</div><div>${profile?.username ? `<strong>${profile.username}</strong>` : `<span class="muted">Not set</span>`}</div>
            </div>

            <hr/>

            <h3 style="margin:0 0 6px 0">Update name</h3>
            <form method="POST" action="/apps/nuggetdepot/me/name?${qs}">
              <label for="first_name">First name</label>
              <input id="first_name" name="first_name" value="${first}" required />

              <label for="last_name">Last name</label>
              <input id="last_name" name="last_name" value="${last}" required />

              <button class="btn" type="submit">Save name</button>
            </form>

            <hr/>

            <h3 style="margin:0 0 6px 0">Update profile photo</h3>
            <form method="POST" enctype="multipart/form-data" action="/apps/nuggetdepot/me/avatar?${qs}">
              <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp" required />
              <div class="muted small">Square recommended. Max 2MB. PNG, JPG, or WEBP.</div>
              <button class="btn" type="submit">Upload photo</button>
            </form>
          </div>
        </div>
      `,
      shop
    )
  );
});

/** Save first/last name */
proxy.post("/me/name", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const qs = signedQueryString(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const first_name = cleanText(req.body?.first_name, 40);
  const last_name = cleanText(req.body?.last_name, 40);

  if (!first_name || !last_name) return res.redirect(`/apps/nuggetdepot/me?err=1&${qs}`);

  try {
    await ensureRow(customerId, shop);
    await updateProfile(customerId, { first_name, last_name });
    return res.redirect(`/apps/nuggetdepot/me?saved=1&${qs}`);
  } catch (e) {
    console.error("name save error:", e);
    return res.redirect(`/apps/nuggetdepot/me?err=1&${qs}`);
  }
});

/** Upload avatar */
proxy.post("/me/avatar", upload.single("avatar"), async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId = typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const qs = signedQueryString(req);

  if (!customerId) return res.status(200).type("text").send("Not logged in");
  if (!pool) return res.status(200).type("text").send("DB not configured");

  const file = req.file;
  if (!file || !file.buffer || !file.mimetype) return res.redirect(`/apps/nuggetdepot/me?imgerr=1&${qs}`);

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.mimetype)) return res.redirect(`/apps/nuggetdepot/me?imgerr=1&${qs}`);

  try {
    await ensureRow(customerId, shop);
    await updateProfile(customerId, {
      avatar_bytes: file.buffer,
      avatar_mime: file.mimetype,
    });
    return res.redirect(`/apps/nuggetdepot/me?saved=1&${qs}`);
  } catch (e) {
    console.error("avatar upload error:", e);
    return res.redirect(`/apps/nuggetdepot/me?imgerr=1&${qs}`);
  }
});

proxy.get("/collection", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page("My Collection", `<p>Next: saved cards, grades, notes.</p>`, shop));
});

proxy.get("/trades", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page("Trades", `<p>Next: listings, offers, messages.</p>`, shop));
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
