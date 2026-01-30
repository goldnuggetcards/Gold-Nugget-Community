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
      .card{border:1px solid #ddd;border-radius:12px;padding:16px;max-width:820px}
      code{background:#f5f5f5;padding:2px 6px;border-radius:6px}
      .muted{opacity:.75}
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
      ${
        shop
          ? `<p class="muted">Shop: <code>${shop}</code></p>`
          : `<p class="muted">Shop: <code>unknown</code></p>`
      }
    </div>
  </body>
</html>`;
}

// Root page (so your Render URL doesn't show "Not found")
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

// Proxy routes (Shopify App Proxy should point to https://YOUR_SERVER_DOMAIN/proxy)
const proxy = express.Router();
proxy.use(requireProxyAuth);

proxy.get("/", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(
    page(
      "Nugget Depot",
      `
        <p>Proxy working.</p>
        <p>Use the navigation above to explore the sections.</p>
      `,
      shop
    )
  );
});

proxy.get("/me", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(
    page(
      "My Profile",
      `
        <p>Next: show logged-in customer profile details.</p>
        <ul>
          <li>Username</li>
          <li>Saved searches</li>
          <li>Wishlist and watchlist settings</li>
        </ul>
      `,
      shop
    )
  );
});

proxy.get("/collection", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(
    page(
      "My Collection",
      `
        <p>Next: list saved cards, grades, notes, and estimated value.</p>
        <ul>
          <li>Recently added</li>
          <li>By set/era</li>
          <li>By grade</li>
        </ul>
      `,
      shop
    )
  );
});

proxy.get("/trades", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  res.type("html").send(
    page(
      "Trades",
      `
        <p>Next: create trade listings and browse offers.</p>
        <ul>
          <li>Create a listing</li>
          <li>Browse listings</li>
          <li>Messages/offers</li>
        </ul>
      `,
      shop
    )
  );
});

app.use("/proxy", proxy);

// 404 fallback
app.use((req, res) => res.status(404).type("text").send("Not found"));

// Ensure Render sees a bound port
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

// Helpful for graceful shutdowns on Render
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
