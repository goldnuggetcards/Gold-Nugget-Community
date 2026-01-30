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
const SHOPIFY_ADMIN_ACCESS_TOKEN = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
const SHOPIFY_SHOP_DOMAIN = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
const SHOPIFY_API_VERSION = (process.env.SHOPIFY_API_VERSION || "2026-01").trim();

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
      <p class="muted">Shop: <code>${shop || "unknown"}</code></p>
    </div>
  </body>
</html>`;
}

async function shopifyGraphQL({ query, variables }) {
  if (!SHOPIFY_SHOP_DOMAIN) throw new Error("Missing SHOPIFY_SHOP_DOMAIN");
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");

  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Shopify Admin API HTTP ${resp.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Root page (Render)
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

// My Profile (functional)
proxy.get("/me", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const loggedInCustomerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  // If customer not logged in, Shopify sets this blank. :contentReference[oaicite:1]{index=1}
  if (!loggedInCustomerId) {
    return res.type("html").send(
      page(
        "My Profile",
        `
          <p>You are not logged in.</p>
          <a class="btn" href="/account/login">Log in</a>
        `,
        shop
      )
    );
  }

  try {
    const data = await shopifyGraphQL({
      query: `
        query GetCustomer($id: ID!) {
          customer(id: $id) {
            id
            firstName
            lastName
            email
            phone
            createdAt
            defaultAddress {
              city
              province
              country
            }
            metafield(namespace: "nuggetdepot", key: "username") {
              value
            }
          }
        }
      `,
      variables: { id: `gid://shopify/Customer/${loggedInCustomerId}` },
    });

    const c = data?.customer;
    if (!c) {
      return res.status(404).type("html").send(
        page(
          "My Profile",
          `<p>Customer not found for this session.</p>`,
          shop
        )
      );
    }

    const username =
      (c.metafield?.value || "").trim() ||
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
      `Trainer ${String(loggedInCustomerId).slice(-4)}`;

    const address = c.defaultAddress
      ? [c.defaultAddress.city, c.defaultAddress.province, c.defaultAddress.country]
          .filter(Boolean)
          .join(", ")
      : "";

    return res.type("html").send(
      page(
        "My Profile",
        `
          <p>Welcome, <strong>${username}</strong>.</p>
