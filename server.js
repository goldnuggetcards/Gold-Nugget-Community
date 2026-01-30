proxy.get("/me/username", async (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const customerId =
    typeof req.query.logged_in_customer_id === "string" ? req.query.logged_in_customer_id : "";

  const qs = signedQueryString(req);

  // If already logged in, skip this page entirely
  if (customerId) {
    const profile = await getProfile(customerId);
    const needsOnboarding =
      !profile?.username || !profile?.full_name || !profile?.dob || !profile?.favorite_pokemon;

    return res.redirect(needsOnboarding ? `/apps/nuggetdepot/onboarding?${qs}` : `/apps/nuggetdepot?${qs}`);
  }

  const returnUrl = "/apps/nuggetdepot";
  const registerUrl = `/account/register?return_url=${encodeURIComponent("/apps/nuggetdepot/onboarding")}`;

  return res.type("html").send(
    page(
      "Log in",
      `
        <form method="POST" action="/account/login">
          <label for="email">Email</label>
          <input id="email" name="customer[email]" type="email" autocomplete="email" required />

          <label for="password">Password</label>
          <input id="password" name="customer[password]" type="password" autocomplete="current-password" required />

          <input type="hidden" name="return_url" value="${returnUrl}" />

          <button class="btn" type="submit">Log in</button>
        </form>

        <hr/>

        <a href="${registerUrl}">Create account</a>
      `,
      shop,
      false
    )
  );
});
