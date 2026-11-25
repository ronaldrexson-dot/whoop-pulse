// WHOOP OAuth + API proxy (Netlify Function, v2 format).
// WHOOP requires the client secret and all API calls to stay server-side,
// so the browser only ever talks to this function. Tokens live in
// HttpOnly cookies; the page never sees them.
//
// Env vars (Netlify → Site settings → Environment variables):
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET
// Redirect URI to register in the WHOOP Developer Dashboard:
//   https://<your-site>.netlify.app/.netlify/functions/whoop?action=callback

const WHOOP = "https://api.prod.whoop.com";
const SCOPES = "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";
const COOKIE_BASE = "Path=/; HttpOnly; Secure; SameSite=Lax";

function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; ${COOKIE_BASE}`;
}

function tokenCookies(t) {
  const expAt = Date.now() + (t.expires_in || 3600) * 1000 - 60_000; // refresh a minute early
  const list = [
    cookie("wa", t.access_token, 60 * 60 * 2),
    cookie("wx", String(expAt), 60 * 60 * 24 * 90),
  ];
  if (t.refresh_token) list.push(cookie("wr", t.refresh_token, 60 * 60 * 24 * 90));
  return list;
}

function json(body, status = 200, cookies = []) {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

// WHOOP's token endpoint can be slow on a cold refresh (reports of 7–11 s),
// and it rotates the refresh token, so never give up early.
async function tokenRequest(params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(`${WHOOP}/oauth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        ...params,
      }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`token ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "status";
  const self = `${url.origin}${url.pathname}`;
  const redirectUri = `${self}?action=callback`;
  const cookies = parseCookies(req.headers.get("cookie"));

  if (!process.env.WHOOP_CLIENT_ID || !process.env.WHOOP_CLIENT_SECRET) {
    return json({ error: "Server is missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET" }, 500);
  }

  if (action === "login") {
    const state = crypto.randomUUID().replace(/-/g, "");
    const auth = new URL(`${WHOOP}/oauth/oauth2/auth`);
    auth.search = new URLSearchParams({
      client_id: process.env.WHOOP_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      state,
    });
    const h = new Headers({ location: auth.toString() });
    h.append("set-cookie", cookie("ws", state, 600));
    return new Response(null, { status: 302, headers: h });
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error")) {
      return Response.redirect(`${url.origin}/?whoop=denied#whoop`, 302);
    }
    if (!code || !state || state !== cookies.ws) {
      return new Response("State mismatch. Start the WHOOP connection again from the app.", { status: 400 });
    }
    const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

    // Owner lock: only the WHOOP account in WHOOP_ALLOWED_USER_ID may sign in.
    // Fails closed: if the variable isn't set yet, nobody is let in and the
    // page shows the user ID to put in it.
    const pr = await fetch(`${WHOOP}/developer/v2/user/profile/basic`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    const profile = pr.ok ? await pr.json() : {};
    const uid = String(profile.user_id ?? "");
    const allowed = String(process.env.WHOOP_ALLOWED_USER_ID || "").trim();
    if (!uid || !allowed || uid !== allowed) {
      const msg = !allowed && uid
        ? `Almost done. Your WHOOP user ID is ${uid}. In Netlify, set WHOOP_ALLOWED_USER_ID to ${uid}, redeploy, then connect WHOOP again from the app.`
        : "This Pulse app is locked to its owner's WHOOP account.";
      const h = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      h.append("set-cookie", cookie("ws", "", 0));
      return new Response(msg, { status: 403, headers: h });
    }

    const h = new Headers({ location: `${url.origin}/?whoop=ok#whoop` });
    for (const c of tokenCookies(t)) h.append("set-cookie", c);
    h.append("set-cookie", cookie("ws", "", 0));
    return new Response(null, { status: 302, headers: h });
  }

  if (action === "logout") {
    return json({ ok: true }, 200, ["wa", "wr", "wx"].map((n) => cookie(n, "", 0)));
  }

  // Everything below needs tokens.
  let access = cookies.wa;
  let setCookies = [];
  const expired = !access || Date.now() > Number(cookies.wx || 0);
  if (expired) {
    if (!cookies.wr) return json({ connected: false }, 401);
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: cookies.wr, scope: "offline" });
      access = t.access_token;
      setCookies = tokenCookies(t);
    } catch (e) {
      return json({ connected: false, error: String(e.message || e) }, 401);
    }
  }

  if (action === "status") return json({ connected: true }, 200, setCookies);

  if (action === "api") {
    const path = url.searchParams.get("path") || "";
    if (!/^\/developer\/v2\/[a-z0-9/_\-?=&.:%]+$/i.test(path)) return json({ error: "bad path" }, 400);
    const r = await fetch(`${WHOOP}${path}`, { headers: { authorization: `Bearer ${access}` } });
    const body = await r.text();
    const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const c of setCookies) h.append("set-cookie", c);
    return new Response(body || "{}", { status: r.status, headers: h });
  }

  return json({ error: "unknown action" }, 400);
};
