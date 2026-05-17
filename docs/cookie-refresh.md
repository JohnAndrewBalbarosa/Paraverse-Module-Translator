# Cookie Refresh Workflow

This project no longer launches Chromium on every run. Instead, it reads a
`cookies.json` file at the repo root and uses plain HTTP (`node-fetch`) for
all data fetching — curriculum HTML, module HTML, and PDF downloads.

You sign in **once** in your normal browser; you only need to refresh the
cookie file when the Paraverse session expires.

## Why this exists

- Microsoft OAuth + MFA (number-matching push to phone) can't be automated
  with `curl` alone. The realistic path is: sign in once in a real browser,
  then reuse the resulting session cookies from a headless script.
- The old flow launched a persistent Chromium profile every run. New flow
  spawns zero browsers as long as cookies are valid.

## One-time setup

1. Open `https://paraverse.feutech.edu.ph/network-map/curriculum/` in your
   normal browser (Edge / Chrome). Complete Microsoft sign-in + MFA.
2. Press `F12` to open DevTools. Switch to the **Console** tab.
3. Run `npm run cookies:snippet` and paste the printed snippet into the
   browser console. It copies a `cookies.json` payload to your clipboard.
4. Paste the clipboard contents into `cookies.json` at the project root.
5. Verify: `npm run check-session`. Expected output:
   `[check-session] OK -- fetched N bytes`.

## When the session expires

You'll see one of these in any script that hits Paraverse:

```
[auth] Session expired: Request to ... was redirected to the login page ...
[auth] Refresh cookies.json -- see docs/cookie-refresh.md.
```

Repeat steps 1-5 above. The browser usually remembers your MFA approval, so
this is normally just one click + the MFA number.

## HttpOnly cookies (fallback)

`document.cookie` (used by the snippet) cannot read `HttpOnly` cookies. If
`npm run check-session` keeps failing right after a fresh paste, the
Paraverse session cookie is probably HttpOnly. Use one of these:

### Option A: DevTools Application tab

1. DevTools -> Application -> Storage -> Cookies ->
   `https://paraverse.feutech.edu.ph`.
2. Select all rows (Ctrl+A), right-click -> Copy.
3. Reshape into the JSON array format below and save as `cookies.json`.

### Option B: Cookie-Editor browser extension

1. Install [Cookie-Editor](https://cookie-editor.com/) for Edge/Chrome.
2. While on a Paraverse page, click the extension -> Export -> JSON.
3. Trim to just entries whose `domain` is `feutech.edu.ph` (or
   `.feutech.edu.ph` / `paraverse.feutech.edu.ph`).
4. Save as `cookies.json`.

## Expected `cookies.json` shape

```json
[
  {
    "name": "laravel_session",
    "value": "eyJpdiI6...",
    "domain": ".feutech.edu.ph",
    "path": "/",
    "expires": 1735689600,
    "httpOnly": true,
    "secure": true,
    "sameSite": "Lax"
  },
  {
    "name": "XSRF-TOKEN",
    "value": "eyJpdiI6...",
    "domain": ".feutech.edu.ph",
    "path": "/"
  }
]
```

Only `name` and `value` are required. `domain` defaults to
`paraverse.feutech.edu.ph` and `path` defaults to `/`.

## `curl` interop

If you want to test endpoints directly with `curl`:

```powershell
npm run check-session -- --emit-curl
# writes cookies.txt in Netscape format
curl -b cookies.txt "https://paraverse.feutech.edu.ph/network-map/curriculum/" -o test.html
```

`cookies.json` and `cookies.txt` are git-ignored — never commit them.

## Emergency fallback: use Chromium

The Playwright path is still wired in. If headless cookies are misbehaving
and you need the old behavior temporarily:

```powershell
npm start -- --use-browser
```

This re-opens the persistent Chromium profile in `sessions/profile/` and
runs the same flow as before.
