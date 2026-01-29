import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* Env */
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const PORT = process.env.PORT || 3000;

/* Simple checks */
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/debug/env", (req, res) => {
  res.json({
    hasApiSecret: !!SHOPIFY_API_SECRET,
    hasAdminToken: !!SHOPIFY_ADMIN_ACCESS_TOKEN,
    shopDomain: SHOPIFY_SHOP_DOMAIN || null,
    apiVersion: SHOPIFY_API_VERSION || null,
  });
});

/* Proxy verification */
function verifyShopifyProxy(req) {
  const query = { ...req.query };
  const signature = query.signature;
  delete query.signature;

  const message = Object.keys(query)
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(",") : query[k]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  return digest === signature;
}

function requireProxyAuth(req, res, next) {
  if (!SHOPIFY_API_SECRET) return res.status(200).type("text").send("Missing SHOPIFY_API_SECRET");
  if (!verifyShopifyProxy(req)) return res.status(200).type("text").send("Invalid proxy signature");
  next();
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* Proxy landing */
app.get("/proxy", requireProxyAuth, (req, res) => {
  res.type("html").send(`
    <h1>Gold Nugget Community</h1>
    <ul>
      <li><a href="/apps/community/me">My Profile</a></li>
    </ul>
  `);
});

/* Minimal token test at /me */
app.get("/proxy/me", requireProxyAuth, async (req, res) => {
  const customerId = req.query.logged_in_customer_id;

  if (!customerId) {
    return res.type("html").send(`
      <h1>Me</h1>
      <p>You must be logged in.</p>
      <a href="/account/login?return_url=${encodeURIComponent("/apps/community/me")}">Log in</a>
    `);
  }

  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const query = `query ($id: ID!) { customer(id: $id) { id email } }`;
  const variables = { id: `gid://shopify/Customer/${customerId}` };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await resp.text();

    return res.status(200).type("html").send(`
      <h1>Me (Token Test)</h1>
      <p>Status: ${resp.status}</p>
      <pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>
      <p><a href="/apps/community">Back</a></p>
    `);
  } catch (e) {
    return res.status(200).type("html").send(`
      <h1>Me (Token Test)</h1>
      <pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(e?.message || String(e))}</pre>
      <p><a href="/apps/community">Back</a></p>
    `);
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
