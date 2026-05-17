#!/usr/bin/env node

const SNIPPET = `
// Run this in your browser's DevTools Console while logged in at
// https://paraverse.feutech.edu.ph/  (any page on that domain).
// It copies a cookies.json payload to your clipboard.
//
// NOTE: document.cookie cannot see HttpOnly cookies. If the script
// reports zero relevant cookies, use the manual export fallback below.

(() => {
  const cookies = document.cookie.split('; ').filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    const name = idx === -1 ? pair : pair.slice(0, idx);
    const value = idx === -1 ? '' : pair.slice(idx + 1);
    return { name, value, domain: '.feutech.edu.ph', path: '/', secure: true, sameSite: 'Lax' };
  });
  const json = JSON.stringify(cookies, null, 2);
  copy(json);
  console.log('[paraverse] copied', cookies.length, 'cookie(s) to clipboard');
  console.log(json);
})();
`;

const MANUAL_FALLBACK = `
Manual fallback (if the snippet above misses HttpOnly cookies):

  1. Open DevTools (F12) on a Paraverse page.
  2. Application tab -> Storage -> Cookies -> https://paraverse.feutech.edu.ph
  3. Select all rows (Ctrl+A), right-click -> Copy.
  4. Paste into a text editor and reshape into JSON:
       [
         { "name": "...", "value": "...", "domain": ".feutech.edu.ph", "path": "/" },
         ...
       ]
  5. Save the file as cookies.json in the project root.

Or use a browser extension like "Cookie-Editor" -> Export -> JSON, and
trim it down to the paraverse.feutech.edu.ph entries only.
`;

console.log("=== Cookie Refresh Snippet ===");
console.log(SNIPPET);
console.log(MANUAL_FALLBACK);
console.log("After saving cookies.json, verify with: npm run check-session");
