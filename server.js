import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; // from your app

function verifyShopifyProxy(req) {
  const query = { ...req.query };
  const signature = query.signature;
  delete query.signature;

  const sorted = Object.keys(query)
    .sort()
    .map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(",") : query[key]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(sorted)
    .digest("hex");

  return digest === signature;
}

app.get("/proxy", (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");

  res.type("html").send(`
    <html>
      <head><title>Gold Nugget Community</title></head>
      <body>
        <h1>Community proxy is working</h1>
        <p>Next: render profile and collection pages.</p>
        <ul>
          <li><a href="/apps/community/me">My Profile</a></li>
          <li><a href="/apps/community/collection">My Collection</a></li>
          <li><a href="/apps/community/trades">Trades</a></li>
        </ul>
      </body>
    </html>
  `);
});

app.get("/proxy/me", (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");
  res.type("html").send("<h1>My Profile (placeholder)</h1>");
});

app.get("/proxy/collection", (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");
  res.type("html").send("<h1>My Collection (placeholder)</h1>");
});

app.get("/proxy/trades", (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");
  res.type("html").send("<h1>Trades (placeholder)</h1>");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Proxy server running");
});

