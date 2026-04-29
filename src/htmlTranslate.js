function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectTextSegments(html) {
  const segments = [];
  const regex = />([^<]+)</g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const raw = match[1];
    const trimmed = raw.replace(/\s+/g, " ").trim();

    if (!trimmed) {
      continue;
    }

    if (/^[\d\s.,:;!?()\-_/]+$/.test(trimmed)) {
      continue;
    }

    segments.push({
      raw,
      normalized: trimmed
    });
  }

  return segments;
}

async function translateHtmlPreservingMarkup(html, translator) {
  if (!translator.canTranslate()) {
    return html;
  }

  const segments = collectTextSegments(html);
  const unique = [...new Set(segments.map((s) => s.normalized))];

  const dictionary = new Map();
  for (const text of unique) {
    const translated = await translator.translateText(text);
    dictionary.set(text, translated);
  }

  let output = html;
  for (const [source, translated] of dictionary.entries()) {
    const pattern = new RegExp(`>(\\s*)${escapeForRegExp(source)}(\\s*)<`, "g");
    output = output.replace(pattern, `>$1${translated}$2<`);
  }

  return output;
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPageObjectFromHtml(html) {
  const cleaned = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const headingRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  const headings = [...cleaned.matchAll(headingRe)];

  if (!headings.length) {
    const text = stripTags(cleaned).trim();
    return { "PAGE 1": text };
  }

  const sections = [];

  const beforeFirst = stripTags(cleaned.slice(0, headings[0].index)).trim();
  if (beforeFirst) sections.push(beforeFirst);

  for (let i = 0; i < headings.length; i++) {
    const headingText = stripTags(headings[i][0]).trim();
    const contentStart = headings[i].index + headings[i][0].length;
    const contentEnd = i + 1 < headings.length ? headings[i + 1].index : cleaned.length;
    const bodyText = stripTags(cleaned.slice(contentStart, contentEnd)).trim();
    const page = [headingText, bodyText].filter(Boolean).join("\n");
    sections.push(page);
  }

  const pageObject = {};
  for (let i = 0; i < sections.length; i++) {
    pageObject[`PAGE ${i + 1}`] = sections[i];
  }
  return pageObject;
}

module.exports = {
  translateHtmlPreservingMarkup,
  buildPageObjectFromHtml
};
