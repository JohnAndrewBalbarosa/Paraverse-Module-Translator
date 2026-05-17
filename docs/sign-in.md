# Sign-in (Headless)

This project never opens a visible browser window. The sign-in step runs an
invisible Chromium process to walk through Microsoft OAuth + MFA, harvests
the resulting cookies into `cookies.json`, and shuts the browser down. All
subsequent runs (`npm start`, `npm run check-session`, etc.) use plain
`node-fetch` — zero browser.

## Why a browser at all for sign-in?

Microsoft OAuth + number-matching MFA is **not** fully scriptable with pure
`curl`:

- The MFA number (e.g. "47") is pushed to your phone; you must physically
  tap it in the Authenticator app. No script bypasses that.
- `login.microsoftonline.com` uses anti-bot signals (JS challenges, device
  fingerprinting, rotating canary tokens). Pure-curl reimplementations
  break every few weeks.

Running a headless Chromium **just for the sign-in step** gives us the JS
context Microsoft requires, while keeping you in the terminal. After
sign-in succeeds, the cookies are portable to any HTTP client.

## First-time sign-in

```powershell
npm run login
```

You'll be prompted in the terminal for:

1. `FEU Microsoft email:` — your `@fit.edu.ph` / `@feu.edu.ph` address.
2. `Password (hidden):` — typed characters appear as `*`.

Then watch the terminal. You'll see one of:

- `[login] *** Tap 47 in your Microsoft Authenticator app ***` — open the
  app on your phone and tap that exact number.
- `[login] *** Approve the sign-in request ... ***` — older MFA style;
  open the app and tap Approve.

On success:

```
[login] Saved 4 cookie(s) to .../cookies.json
[login] Done. Next run: npm start (zero browser).
```

## Optional: `.env` for fully unattended login

If you want to skip the prompts (e.g. for cron jobs), add to `.env`:

```env
PARAVERSE_USERNAME=jbalbarosa@fit.edu.ph
PARAVERSE_PASSWORD=your-password
```

You'll still need to tap the MFA number on your phone — `.env` only
removes the interactive prompts, not the MFA itself.

`.env` is git-ignored. Never commit it.

## Re-using the trusted device (skipping MFA)

`scripts/login.js` reuses the persistent Chromium profile at
`sessions/profile/`. Microsoft remembers this device, so after the first
successful MFA you may go days or weeks without being prompted again.

If MS forgets and asks for MFA every run, you can enable "Don't ask again
for 90 days" in the Microsoft sign-in page — but that prompt is only shown
in headed mode. To enable it: delete `sessions/profile/`, run
`npm start -- --use-browser` once, check the box, finish login, then go
back to `npm run login` for future sessions.

## When cookies expire

You'll see in any command that hits Paraverse:

```
[auth] Session expired: ...
[auth] Refresh cookies.json — see docs/sign-in.md.
```

Just run `npm run login` again. MFA will only prompt if MS no longer
trusts the device.

## Verify a session

```powershell
npm run check-session
```

Expected: `[check-session] OK — fetched N bytes`. Add `-- --emit-curl`
to also write `cookies.txt` in Netscape format for raw `curl` use:

```powershell
npm run check-session -- --emit-curl
curl -b cookies.txt "https://paraverse.feutech.edu.ph/network-map/curriculum/" -o test.html
```

## Files

- `cookies.json` — auth cookies (git-ignored).
- `cookies.txt` — optional Netscape format for `curl` (git-ignored).
- `sessions/profile/` — Chromium persistent profile used only by
  `scripts/login.js` (git-ignored).

## Fallback: headed browser

If headless sign-in misbehaves (e.g. a new MS UI step the script doesn't
recognize yet), the old Playwright path is still wired:

```powershell
npm start -- --use-browser
```

This opens a visible Chromium window, prompts you to log in manually, then
runs the full extract-and-translate flow.
