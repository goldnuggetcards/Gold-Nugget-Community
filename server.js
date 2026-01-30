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
  // v2: key by customer_id only so shop changes do not “lose” data
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles_v2 (
      customer_id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      username TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
      input{padding:10px 12px;border:1px solid #ddd;border-radius:10px;width:280px;max-width:100%}
      label{display:block;margin-top:12px;margin-bottom:6px}
      .error{color:#b00020}
      .ok{color:#137333}
    </style>
  </head>
  <body>
    <div class="nav">
      <a href="/apps/nuggetdepot">Home</a>
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

const proxy = express.Router();
proxy.use(requireProxyAuth);

proxy.get("/", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(page("Nugget Depot", `<p>Proxy working.</p><p>Use the navigation above.</p>`, shop));
});

function cleanUsername(input) {
  const u = String(input || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) return "";
  return u;
}

async function getUsername(customerId) {
  if (!pool) return "";
  await ensureSchema();
  const r = await pool.query("SELECT username FROM profiles_v2 WHERE customer_id=$1", [customerId]);
  return r.rows?.[0]?.username || "";
}

async function setUsername(customerId, shop, username) {
  if (!pool) throw new Error("DB not configured");
  await ensureSchema();
  await pool.query(
    `INSERT INTO profiles_v2 (customer_id, shop, username)
     VALUES ($1,$2,$3)
     ON CONFLICT (customer_id)
     DO UPDATE SET username=EXCLUDED.username, shop=EXCLUDED.shop, updated_at=NOW()`,
    [customerId, shop, username]
  );
}

function signedQueryString(req) {
  return new URLSearchParams(req.query).toString();
}

async function renderProfile(req, res, { saved = false, invalid = false, dbError = false } = {}) {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    return res
      .type("html")
      .send(page("My Profile", `<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`, shop));
  }

  const username = await getUsername(customerId);

  const dbWarning = pool
    ? ""
    : `<p class="error">DATABASE_URL not set. Create Render Postgres and add DATABASE_URL to the web service.</p>`;

  const status = dbError
    ? `<p class="error">Could not save. Check Render logs for Postgres error.</p>`
    : saved
      ? `<p class="ok">Saved.</p>`
      : invalid
        ? `<p class="error">Invalid username.</p>`
        : "";

  const qs = signedQueryString(req);

  return res.type("html").send(
    page(
      "My Profile",
      `
        ${status}
        ${dbWarning}

        <div class="grid">
          <div class="k">Customer ID</div><div><code>${customerId}</code></div>
          <div class="k">Username</div><div>${username ? `<strong>${username}</strong>` : `<span class="muted">Not set</span>`}</div>
        </div>

        <form method="GET" action="/apps/nuggetdepot/me/username?${qs}">
          <label for="username">Set username</label>
          <input id="username" name="username" placeholder="ex: nuggetking" value="${username || ""}" />
          <div class="muted">3–20 characters. Letters, numbers, underscore, dash, dot.</div>
          <button class="btn" type="submit">Save</button>
        </form>
      `,
      shop
    )
  );
}

proxy.get("/me", async (req, res) => {
  return renderProfile(req, res);
});

proxy.get("/me/username", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!customerId) {
    return res.status(401).type("html").send(page("My Profile", `<p>You are not logged in.</p>`, shop));
  }

  const username = cleanUsername(req.query.username);
  if (!username) {
    return renderProfile(req, res, { invalid: true });
  }

  try {
    await setUsername(customerId, shop, username);
    return renderProfile(req, res, { saved: true });
  } catch (e) {
    console.error("setUsername error:", e);
    return renderProfile(req, res, { dbError: true });
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
