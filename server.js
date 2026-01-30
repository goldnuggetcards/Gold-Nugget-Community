import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
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

function requireProxyAuth(req, res, next) {
  if (!SHOPIFY_API_SECRET) return res.status(500).type("text").send("Missing SHOPIFY_API_SECRET");
  if (!verifyShopifyProxy(req)) return res.status(401).type("text").send("Invalid proxy signature");
  return next();
}

function page(title, bodyHtml, shop) {
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
    </style>
  </head>
  <body>
    <div class="nav">
      <a href="/apps/nuggetdepot">Feed</a>
      <a href="/apps/nuggetdepot/me">My Profile</a>
      <a href="/apps/nuggetdepot/collection">My Collection</a>
      <a href="/apps/nuggetdepot/trades">Trades</a>
    </div>
    <hr/>
    <div class="card">
      <h1>${title}</h1>
      ${bodyHtml}
      <p class="muted">Shop: <code>${safeShop}</code></p>
    </div>
  </body>
</html>`;
}

function signedQueryString(req) {
  return new URLSearchParams(req.query).toString();
}

function cleanUsername(input) {
  const u = String(input || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) return "";
  return u;
}

function cleanText(input, max = 60) {
  return String(input || "").trim().slice(0, max);
}

function cleanDob(input) {
  const s = String(input || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

async function getProfile(customerId) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(
    "SELECT customer_id, shop, username, full_name, dob, favorite_pokemon FROM profiles_v2 WHERE customer_id=$1",
    [customerId]
  );
  return r.rows?.[0] || null;
}

async function upsertProfile(customerId, shop, patch) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();

  await pool.query(
    `INSERT INTO profiles_v2 (customer_id, shop)
     VALUES ($1,$2)
     ON CONFLICT (customer_id) DO UPDATE SET shop=EXCLUDED.shop, updated_at=NOW()`,
    [customerId, shop]
  );

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k}=$${idx++}`);
    values.push(v);
  }

  values.push(customerId);

  await pool.query(
    `UPDATE profiles_v2 SET ${fields.join(", ")}, updated_at=NOW() WHERE customer_id=$${idx}`,
    values
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

/** Feed placeholder */
proxy.get("/", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    const qs = signedQueryString(req);
    return res
      .type("html")
      .send(
        page(
          "Nugget Depot",
          `<p>Please log in to view the community feed.</p>
           <a class="btn" href="/apps/nuggetdepot/me/username?${qs}">Log in / Create account</a>`,
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

/** Profile overview */
proxy.get("/me", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    const qs = signedQueryString(req);
    return res
      .type("html")
      .send(
        page(
          "My Profile",
          `<p>You are not logged in.</p>
           <a class="btn" href="/apps/nuggetdepot/me/username?${qs}">Log in / Create account</a>`,
          shop
        )
      );
  }

  const profile = await getProfile(customerId);
  const username = profile?.username || "";
  const fullName = profile?.full_name || "";
  const dob = profile?.dob ? String(profile.dob).slice(0, 10) : "";
  const fav = profile?.favorite_pokemon || "";

  const qs = signedQueryString(req);

  return res.type("html").send(
    page(
      "My Profile",
      `
      <div class="grid">
        <div class="k">Customer ID</div><div><code>${customerId}</code></div>
        <div class="k">Full name</div><div>${fullName ? `<strong>${fullName}</strong>` : `<span class="muted">Not set</span>`}</div>
        <div class="k">DOB</div><div>${dob ? `<strong>${dob}</strong>` : `<span class="muted">Not set</span>`}</div>
        <div class="k">Favorite Pokémon</div><div>${fav ? `<strong>${fav}</strong>` : `<span class="muted">Not set</span>`}</div>
        <div class="k">Username</div><div>${username ? `<strong>${username}</strong>` : `<span class="muted">Not set</span>`}</div>
      </div>

      <div class="row">
        <a class="btn" href="/apps/nuggetdepot/onboarding?${qs}">Edit profile</a>
        <a class="btn" href="/apps/nuggetdepot">Back to feed</a>
      </div>
      `,
      shop
    )
  );
});

/** Login / Signup gateway */
proxy.get("/me/username", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (customerId) {
    const qs = signedQueryString(req);
    return res.type("html").send(
      page(
        "Welcome Back",
        `
          <p>You are logged in.</p>
          <div class="row">
            <a class="btn" href="/apps/nuggetdepot">Go to feed</a>
            <a class="btn" href="/apps/nuggetdepot/onboarding?${qs}">Complete profile</a>
          </div>
        `,
        shop
      )
    );
  }

  const returnUrl = "/apps/nuggetdepot";
  const registerUrl = `/account/register?return_url=${encodeURIComponent(returnUrl)}`;

  return res.type("html").send(
    page(
      "Log in",
      `
        <form method="POST" action="/account/login">
          <label for="email">Email</label>
          <input id="email" name="customer[email]" type="email" autocomplete="email" required />

          <label for="password">Password</label>
          <input id="password" name="customer[password]" type="password" autocomplete="current-password" required />

          <input type="hidden" name="return_url" value="${returnUrl}" />

          <button class="btn" type="submit">Log in</button>
        </form>

        <hr/>

        <a class="btn" href="${registerUrl}">Create account</a>
        <div class="muted" style="margin-top:8px">Account creation happens on Shopify, then you return here.</div>
      `,
      shop
    )
  );
});

/** Onboarding form */
proxy.get("/onboarding", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    const qs = signedQueryString(req);
    return res.type("html").send(
      page(
        "Complete Your Profile",
        `<p>Please log in first.</p><a class="btn" href="/apps/nuggetdepot/me/username?${qs}">Log in</a>`,
        shop
      )
    );
  }

  const profile = await getProfile(customerId);
  const qs = signedQueryString(req);

  const fullName = profile?.full_name || "";
  const dob = profile?.dob ? String(profile.dob).slice(0, 10) : "";
  const fav = profile?.favorite_pokemon || "";
  const username = profile?.username || "";

  const status =
    req.query.saved === "1"
      ? `<p class="ok">Saved.</p>`
      : req.query.err === "1"
        ? `<p class="error">Please check your inputs.</p>`
        : req.query.dberr === "1"
          ? `<p class="error">Could not save. Check Render logs.</p>`
          : "";

  return res.type("html").send(
    page(
      "Create Your Profile",
      `
        ${status}

        <form method="GET" action="/apps/nuggetdepot/onboarding/save?${qs}">
          <label for="full_name">Full name</label>
          <input id="full_name" name="full_name" value="${fullName}" required />

          <label for="dob">DOB</label>
          <input id="dob" name="dob" type="date" value="${dob}" required />

          <label for="favorite_pokemon">Favorite Pokémon</label>
          <input id="favorite_pokemon" name="favorite_pokemon" value="${fav}" required />

          <label for="username">New username</label>
          <input id="username" name="username" value="${username}" placeholder="ex: nuggetking" required />
          <div class="muted">3–20 characters. Letters, numbers, underscore, dash, dot.</div>

          <button class="btn" type="submit">Enter</button>
          <a class="btn" style="margin-left:8px" href="/apps/nuggetdepot">Back</a>
        </form>
      `,
      shop
    )
  );
});

/** Onboarding save */
proxy.get("/onboarding/save", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";
  const qs = signedQueryString(req);

  if (!customerId) {
    return res.type("html").send(
      page("Create Your Profile", `<p>Please log in.</p><a class="btn" href="/apps/nuggetdepot/me/username?${qs}">Log in</a>`, shop)
    );
  }

  const full_name = cleanText(req.query.full_name, 80);
  const favorite_pokemon = cleanText(req.query.favorite_pokemon, 40);
  const username = cleanUsername(req.query.username);
  const dob = cleanDob(req.query.dob);

  if (!full_name || !favorite_pokemon || !username || !dob) {
    return res.type("html").send(
      page(
        "Create Your Profile",
        `<p class="error">Please check your inputs.</p>
         <a class="btn" href="/apps/nuggetdepot/onboarding?err=1&${qs}">Back</a>`,
        shop
      )
    );
  }

  try {
    await upsertProfile(customerId, shop, {
      full_name,
      favorite_pokemon,
      username,
      dob,
    });

    return res.type("html").send(
      page(
        "Welcome",
        `<p class="ok">Profile saved.</p>
         <a class="btn" href="/apps/nuggetdepot">Enter feed</a>`,
        shop
      )
    );
  } catch (e) {
    console.error("onboarding save error:", e);
    return res.type("html").send(
      page(
        "Create Your Profile",
        `<p class="error">Could not save. Check Render logs.</p>
         <a class="btn" href="/apps/nuggetdepot/onboarding?dberr=1&${qs}">Back</a>`,
        shop
      )
    );
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
