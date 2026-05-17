const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { URL } = require("url");
const { loadCookies, toCookieHeader } = require("./cookieJar");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": DEFAULT_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="147", "Not?A_Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1"
};

class SessionExpiredError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "SessionExpiredError";
    this.code = "SESSION_EXPIRED";
    this.info = info;
  }
}

function isLoginRedirectUrl(url) {
  if (!url) return false;
  return /login\.microsoftonline\.com|\/login|\/account\/login-checkpoint/i.test(url);
}

function looksLikeLoginBody(body) {
  if (!body || typeof body !== "string") return false;
  return /login\.microsoftonline\.com|name="loginfmt"|"urlMsaLogout"/i.test(body);
}

function createHttpClient(options = {}) {
  const cookiesPath = options.cookiesPath;
  const cookies = options.cookies || loadCookies(cookiesPath);
  const extraHeaders = options.extraHeaders || {};

  function buildAjaxHeaders(url, referer) {
    return {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "X-Requested-With": "XMLHttpRequest",
      "sec-ch-ua": '"Chromium";v="147", "Not?A_Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      ...(referer ? { Referer: referer } : {})
    };
  }

  function buildHeaders(url, perCallHeaders = {}, init = {}) {
    const cookieHeader = toCookieHeader(cookies, url);
    const base = init.ajax ? buildAjaxHeaders(url, init.referer) : DEFAULT_HEADERS;
    const headers = { ...base, ...extraHeaders, ...perCallHeaders };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    return headers;
  }

  async function rawFetch(url, init = {}) {
    const headers = buildHeaders(url, init.headers || {}, init);
    const response = await fetch(url, {
      method: init.method || "GET",
      headers,
      redirect: init.redirect || "follow",
      timeout: init.timeout || 45000,
      body: init.body
    });

    if (isLoginRedirectUrl(response.url)) {
      throw new SessionExpiredError(
        `Request to ${url} was redirected to the login page (${response.url}). ` +
        `Run: npm run login`,
        { requestedUrl: url, finalUrl: response.url }
      );
    }

    return response;
  }

  async function fetchHtml(url, init = {}) {
    const response = await rawFetch(url, init);
    if (!response.ok) {
      throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (looksLikeLoginBody(text) && /microsoftonline|name="loginfmt"/i.test(text)) {
      throw new SessionExpiredError(
        `Response from ${url} looks like a Microsoft login page. Run: npm run login`,
        { requestedUrl: url, finalUrl: response.url }
      );
    }
    return text;
  }

  async function fetchBinary(url, init = {}) {
    const response = await rawFetch(url, init);
    if (!response.ok) {
      throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`);
    }
    return response.buffer();
  }

  async function downloadToFile(url, destPath, init = {}) {
    const buffer = await fetchBinary(url, init);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return destPath;
  }

  // Shim that quacks like Playwright's APIRequestContext so we can pass it
  // straight into existing helpers (pdfPptTranslate.downloadBinary) without
  // refactoring their signatures.
  function asRequestContextShim() {
    return {
      async get(url, init = {}) {
        const response = await rawFetch(url, init);
        const status = response.status;
        const buf = await response.buffer();
        return {
          ok: () => response.ok,
          status: () => status,
          url: () => response.url,
          body: async () => buf,
          text: async () => buf.toString("utf8")
        };
      }
    };
  }

  return {
    cookies,
    fetchHtml,
    fetchBinary,
    downloadToFile,
    rawFetch,
    asRequestContextShim
  };
}

module.exports = {
  createHttpClient,
  SessionExpiredError,
  DEFAULT_USER_AGENT
};
