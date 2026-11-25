# Pulse: live WHOOP heart rate + WHOOP API stats

- **Live tab**: second-by-second heart rate straight from your WHOOP 5.0 over Bluetooth (the standard Heart Rate Broadcast). It shows zones, average/max/min, 1-minute HRV (RMSSD from R-R intervals) and a calorie estimate, with a 10-minute chart.
- **History tab**: every connection longer than a minute is saved on the phone (IndexedDB). You can label it ("CrossFit"), view its chart and zones, and export it as CSV.
- **WHOOP tab**: recovery, resting HR, HRV, strain, day avg/max HR, SpO2, a 14-day RHR/HRV trend, recent workouts with HR zones, and sleep, all from the official API. Max HR and weight sync from your profile.

## 1. Turn on Heart Rate Broadcast
WHOOP app → More → Device Settings → **Heart Rate Broadcast** → On.

## 2. Create a WHOOP developer app (or reuse yours)
1. https://developer-dashboard.whoop.com → your app.
2. Scopes: `read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline`.
3. Redirect URL: `https://YOUR-SITE.netlify.app/.netlify/functions/whoop?action=callback`
   (fill in YOUR-SITE after step 3, then come back and add it).

## 3. Deploy to Netlify (free)
```bash
npm i -g netlify-cli
cd whoop-hr
netlify deploy --prod      # create a new site when asked
netlify env:set WHOOP_CLIENT_ID     your_client_id
netlify env:set WHOOP_CLIENT_SECRET your_client_secret
netlify deploy --prod      # redeploy so the function picks up the env vars
```
### Lock it to your WHOOP account
The app only lets in one WHOOP account. The first time you tap **Connect WHOOP**, you'll see a message with your WHOOP user ID instead of your data. Then:
```bash
netlify env:set WHOOP_ALLOWED_USER_ID <the id shown>
netlify deploy --prod
```
Connect WHOOP again and you're in. Any other WHOOP account gets "locked to its owner" and receives no tokens.

The client secret only lives in Netlify's environment. Tokens are kept in HttpOnly cookies, and the page never sees them.

## 4. Use it on iPhone
1. Install **Bluefy – Web BLE Browser** from the App Store. Safari has no Bluetooth access for web pages, and neither does Chrome on iOS.
2. Open your Netlify URL in Bluefy → **Connect strap** → choose the WHOOP.
3. Open the **WHOOP** tab → **Connect WHOOP** → sign in once.

On a laptop, Chrome or Edge works the same way.

## Limits
- Live HR only records while Pulse is open in the foreground with the screen on (there's a keep-awake toggle). This is an iOS restriction on web pages.
- Your WHOOP must not be connected to another broadcast receiver at the same moment (a gym machine or bike computer).
- Calories use a generic HR formula (Keytel 2005), so treat them as a rough figure.
- Sessions are stored on the device that recorded them. Export CSV to keep a backup.

## Files
- `public/index.html`: the whole app (no build step)
- `netlify/functions/whoop.mjs`: OAuth + API proxy (WHOOP requires server-side calls)
- `netlify.toml`
