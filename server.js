import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.type("text").send("OK: server is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const PORT = process.env.PORT || 3000;

function verifyShopifyProxy(req) {
  const query = { ...req.query };
  const signature = query.signature;
  delete query.signature;

  const message = Object.keys(query)
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(",") : query[k]}`)
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
    <h1>Gold Nugget Community</h1>
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

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
