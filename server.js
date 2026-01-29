import express from "express";
import crypto from "crypto";

const app = express();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const PORT = process.env.PORT || 3000;

function verifyShopifyProxy(req) {
  const secret = SHOPIFY_API_SECRET;
  if (!secret) return false;

  const query = { ...req.query };

  // App Proxy uses "signature"
  const signature = typeof query.signature === "string" ? query.signature : "";
  if (!signature) return false;

  delete query.signature;

  // Build sorted query string with no separators (Shopify proxy format)
  const message = Object.keys(query)
    .sort()
    .map((key) => {
      const val = query[key];
      const valueStr = Array.isArray(val) ? val.join(",") : String(val);
      return `${key}=${valueStr}`;
    })
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  // timing-safe compare
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireProxyAuth(req, res, next) {
  if (!SHOPIFY_API_SECRET) return res.status(500).send("Missing SHOPIFY_API_SECRET");
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");
  next();
}

app.get("/proxy", requireProxyAuth, (req, res) => {
  res.type("html").send(`
    <h1>Nugget Depot</h1>
    <p>Proxy working.</p>
    <ul>
      <li><a href="/apps/community/me">My Profile</a></li>
      <li><a href="/apps/community/collection">My Collection</a></li>
      <li><a href="/apps/community/trades">Trades</a></li>
    </ul>
  `);
});

app.get("/proxy/me", requireProxyAuth, (req, res) => {
  res.type("html").send("<h1>My Profile</h1><p>Placeholder</p>");
});

app.get("/proxy/collection", requireProxyAuth, (req, res) => {
  res.type("html").send("<h1>My Collection</h1><p>Placeholder</p>");
});

app.get("/proxy/trades", requireProxyAuth, (req, res) => {
  res.type("html").send("<h1>Trades</h1><p>Placeholder</p>");
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
