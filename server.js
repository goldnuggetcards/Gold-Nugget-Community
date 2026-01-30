import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");

// Basic request logging (useful on Render)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const SHOPIFY_API_SECRET = (process.env.SHOPIFY_API_SECRET || "").trim();
const PORT = Number(process.env.PORT) || 3000;

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
      .btn{display:inline-block;margin-top:12px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;text-decoration:none}
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

// Root page (Render URL)
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

// Health check for Render
app.get("/healthz", (req, res) => res.status(200).type("text").send("ok"));

// Proxy routes
const proxy = express.Router();
proxy.use(requireProxyAuth);

proxy.get("/", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(
    page(
      "Nugget Depot",
      `<p>Proxy working.</p><p>Use the navigation above.</p>`,
      shop
    )
  );
});

// My Profile (functional without Admin API: shows login state + lets you set a username later)
proxy.get("/me", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const loggedInCustomerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  if (!loggedInCustomerId) {
    return res.type("html").send(
      page(
        "My Profile",
        `<p>You are not logged in.</p><a class="btn" href="/account/login">Log in</a>`,
        shop
      )
    );
  }

  return res.type("html").send(
    page(
      "My Profile",
      `
        <p>Logged in.</p>
        <div class="grid">
          <div class="k">Customer ID</div><div><code>${loggedInCustomerId}</code></div>
        </div>
        <h2 style="margin-top:18px">Next</h2>
        <ul>
          <li>Save a username (stored in our DB keyed to your customer ID)</li>
          <li>Show your collection count</li>
          <li>Show your trade listings</li>
        </ul>
      `,
      shop
    )
  );
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

// 404 fallback
app.use((req, res) => res.status(404).type("text").send("Not found"));

// Ensure Render sees a bound port
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0)
