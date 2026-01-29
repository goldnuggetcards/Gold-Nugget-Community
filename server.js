import express from "express";
import crypto from "crypto";

const app = express();

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; // required
const PORT = process.env.PORT || 3000;

function verifyShopifyProxy(req) {
  // Shopify App Proxy uses "signature" param for verification
  const query = { ...req.query };
  const signature = query.signature;
  delete query.signature;

  // Build sorted query string with no separators
  const message = Object.keys(query)
    .sort()
    .map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(",") : query[key]}`)
    .join("");

  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
  return digest === signature;
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
