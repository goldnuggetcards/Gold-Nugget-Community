import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Debug route (temporary). Remove after everything is stable.
app.get("/debug/env", (req, res) => {
  res.json({
    hasApiSecret: !!process.env.SHOPIFY_API_SECRET,
    hasAdminToken: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || null,
    apiVersion: process.env.SHOPIFY_API_VERSION || null,
  });
});

/* Public routes for testing Render only */
app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Gold Nugget Community</h1>
    <p>Server is running.</p>
    <ul>
      <li><a href="https://www.goldnuggetcards.com/apps/community" target="_blank" rel="noreferrer">Open Community (storefront)</a></li>
      <li><a href="/health" target="_blank" rel="noreferrer">Health check</a></li>
    </ul>
  `);
});

app.get("/health", (req, res) => res.json({ ok: true }));

/* Env */
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const PORT = process.env.PORT || 3000;

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
  if (!SHOPIFY_API_SECRET) return res.status(500).send("Missing SHOPIFY_API_SECRET");
  if (!verifyShopifyProxy(req)) return res.status(401).send("Invalid proxy signature");
  next();
}

/* Shopify GraphQL helper */
async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (!SHOPIFY_SHOP_DOMAIN) throw new Error("Missing SHOPIFY_SHOP_DOMAIN");

  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();

  if (!resp.ok || json.errors) {
    throw new Error(
      JSON.stringify(
        { status: resp.status, errors: json.errors, data: json.data },
        null,
        2
      )
    );
  }

  return json.data;
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Important: returns HTTP 200 so Shopify shows the error details instead of a generic “third-party application” page.
function showErrorPage(res, title, details) {
  console.error(title, details);
  return res.status(200).type("html").send(`
    <h1>${escapeHtml(title)}</h1>
    <pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(details || "")}</pre>
    <p><a href="/apps/community">Back</a></p>
  `);
}

/* Landing */
app.get("/proxy", requireProxyAuth, (req, res) => {
  res.type("html").send(`
    <h1>Gold Nugget Community</h1>
    <ul>
      <li><a href="/apps/community/me">My Profile</a></li>
      <li><a href="/apps/community/collection">My Collection</a></li>
      <li><a href="/apps/community/trades">Trades</a></li>
    </ul>
  `);
});

/* 2.2: My Profile (GET) */
const GET_PROFILE = `
  query GetProfile($id: ID!) {
    customer(id: $id) {
      id
      email
      metafields(identifiers: [
        {namespace: "profile", key: "username"}
        {namespace: "profile", key: "display_name"}
        {namespace: "profile", key: "bio"}
        {namespace: "privacy", key: "profile_visibility"}
        {namespace: "privacy", key: "collection_visibility"}
      ]) {
        namespace
        key
        value
      }
    }
  }
`;

app.get("/proxy/me", requireProxyAuth, async (req, res) => {
  const customerId = req.query.logged_in_customer_id;

  if (!customerId) {
    const returnUrl = encodeURIComponent("/apps/community/me");
    return res.type("html").send(`
      <h1>My Profile</h1>
      <p>You must be logged in.</p>
      <a href="/account/login?return_url=${returnUrl}">Log in</a>
    `);
  }

  const customerGid = `gid://shopify/Customer/${customerId}`;

  let data;
  try {
    data = await shopifyGraphQL(GET_PROFILE, { id: customerGid });
  } catch (e) {
    return showErrorPage(res, "Shopify API error (GET /me)", e?.message || String(e));
  }

  const mf = Object.fromEntries(
    (data.customer?.metafields || []).map((m) => [`${m.namespace}.${m.key}`, m.value])
  );

  const username = mf["profile.username"] || "";
  const displayName = mf["profile.display_name"] || "";
  const bio = mf["profile.bio"] || "";
  const profileVis = mf["privacy.profile_visibility"] || "private";
  const collectionVis = mf["privacy.collection_visibility"] || "private";

  const saved = req.query.saved === "1";

  res.type("html").send(`
    <h1>My Profile</h1>
    ${saved ? "<p><strong>Saved.</strong></p>" : ""}

    <form method="POST" action="/apps/community/me">
      <label>Username (lowercase, numbers, underscore)</label><br/>
      <input name="username" value="${escapeHtml(username)}" placeholder="example: nugget_collector" /><br/><br/>

      <label>Display name</label><br/>
      <input name="display_name" value="${escapeHtml(displayName)}" placeholder="What people see" /><br/><br/>

      <label>Bio</label><br/>
      <textarea name="bio" rows="5" cols="45" placeholder="Collector info...">${escapeHtml(bio)}</textarea><br/><br/>

      <label>Profile visibility</label><br/>
      <select name="profile_visibility">
        <option value="private" ${profileVis === "private" ? "selected" : ""}>private</option>
        <option value="public" ${profileVis === "public" ? "selected" : ""}>public</option>
      </select><br/><br/>

      <label>Collection visibility</label><br/>
      <select name="collection_visibility">
        <option value="private" ${collectionVis === "private" ? "selected" : ""}>private</option>
        <option value="public" ${collectionVis === "public" ? "selected" : ""}>public</option>
      </select><br/><br/>

      <button type="submit">Save</button>
    </form>
  `);
});

/* 2.2: My Profile (POST) */
const SET_PROFILE = `
  mutation SetProfile($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key value }
      userErrors { field message code }
    }
  }
`;

app.post("/proxy/me", requireProxyAuth, async (req, res) => {
  const customerId = req.query.logged_in_customer_id;
  if (!customerId) {
    return showErrorPage(res, "Not logged in", "logged_in_customer_id was not provided by Shopify.");
  }

  const username = (req.body.username || "").trim();
  const displayName = (req.body.display_name || "").trim();
  const bio = (req.body.bio || "").trim();
  const profileVis = (req.body.profile_visibility || "private").trim();
  const collectionVis = (req.body.collection_visibility || "private").trim();

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return showErrorPage(
      res,
      "Validation error",
      "Username must be 3-20 characters and only lowercase letters, numbers, underscore."
    );
  }
  if (!["private", "public"].includes(profileVis)) {
    return showErrorPage(res, "Validation error", "Invalid profile visibility.");
  }
  if (!["private", "public"].includes(collectionVis)) {
    return showErrorPage(res, "Validation error", "Invalid collection visibility.");
  }

  const ownerId = `gid://shopify/Customer/${customerId}`;

  const metafields = [
    { ownerId, namespace: "profile", key: "username", type: "single_line_text_field", value: username },
    { ownerId, namespace: "profile", key: "display_name", type: "single_line_text_field", value: displayName },
    { ownerId, namespace: "profile", key: "bio", type: "multi_line_text_field", value: bio },
    { ownerId, namespace: "privacy", key: "profile_visibility", type: "single_line_text_field", value: profileVis },
    { ownerId, namespace: "privacy", key: "collection_visibility", type: "single_line_text_field", value: collectionVis },
  ];

  let data;
  try {
    data = await shopifyGraphQL(SET_PROFILE, { metafields });
  } catch (e) {
    return showErrorPage(res, "Shopify API error (POST /me)", e?.message || String(e));
  }

  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    return showErrorPage(res, "Save failed", errors.map((e) => e.message).join("\n"));
  }

  res.redirect("/apps/community/me?saved=1");
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
