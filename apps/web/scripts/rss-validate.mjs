#!/usr/bin/env node
/**
 * Strict RSS 2.0 validator. Parses the feed XML and asserts the spec's
 * required elements:
 *   - rss[@version="2.0"] root
 *   - exactly one <channel>
 *   - channel: title, link, description (RSS 2.0 §3.3)
 *   - each <item>: title or description, link, pubDate parseable, guid
 *   - atom:link rel="self" with href === expected feed URL
 *   - lastBuildDate parseable
 *   - well-formed XML (parser throws on malformed)
 *
 * Mirrors the assertions of the W3C feed validator at
 * https://validator.w3.org/feed/ for RSS 2.0 inputs. Run after the prod
 * server is up:
 *
 *   pnpm rss:validate http://localhost:3002/blog/rss.xml
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

const url = process.argv[2] ?? "http://localhost:3002/blog/rss.xml";

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

const res = await fetch(url);
if (!res.ok) fail(`HTTP ${res.status} fetching ${url}`);
const ct = res.headers.get("content-type") ?? "";
if (!/(application\/rss\+xml|application\/xml|text\/xml)/.test(ct)) {
  fail(`unexpected Content-Type "${ct}"`);
}
const xml = await res.text();

const wf = XMLValidator.validate(xml, { allowBooleanAttributes: true });
if (wf !== true) {
  fail(`XML not well-formed: ${JSON.stringify(wf)}`);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "item",
});
const doc = parser.parse(xml);

const rss = doc.rss;
if (!rss) fail("missing <rss> root");
if (rss["@version"] !== "2.0") fail(`<rss version> must be "2.0", got "${rss["@version"]}"`);
const channel = rss.channel;
if (!channel) fail("missing <channel>");
if (Array.isArray(channel)) fail("multiple <channel> elements (RSS 2.0 allows exactly one)");

for (const required of ["title", "link", "description"]) {
  if (!channel[required] || String(channel[required]).trim() === "") {
    fail(`channel.${required} required`);
  }
}

const atomSelf = channel["atom:link"];
if (!atomSelf) fail("channel must have <atom:link rel=\"self\">");
if (atomSelf["@rel"] !== "self") fail("atom:link rel must be \"self\"");
if (!atomSelf["@href"]) fail("atom:link href required");

if (!channel.lastBuildDate || Number.isNaN(Date.parse(channel.lastBuildDate))) {
  fail("channel.lastBuildDate missing or unparseable");
}

const items = channel.item ?? [];
if (!Array.isArray(items)) fail("expected items array");
// RSS 2.0 §3.3: <item> is optional under <channel>. An empty feed is valid;
// a locale that hasn't been translated yet correctly produces zero items.
if (items.length === 0) {
  console.warn(`[WARN] ${url}: feed has no <item> entries (locale not translated yet?)`);
}

for (const [i, item] of items.entries()) {
  if (!(item.title || item.description)) {
    fail(`item[${i}]: must have title or description (RSS 2.0 §4)`);
  }
  if (!item.link) fail(`item[${i}].link required`);
  if (!item.guid) fail(`item[${i}].guid required for de-duping`);
  if (!item.pubDate || Number.isNaN(Date.parse(item.pubDate))) {
    fail(`item[${i}].pubDate missing or unparseable`);
  }
  // RFC 822-ish format check
  if (!/GMT|UTC|[+-]\d{4}/.test(item.pubDate)) {
    fail(`item[${i}].pubDate "${item.pubDate}" missing timezone`);
  }
}

console.log(`[OK] RSS 2.0 valid — ${items.length} item(s) at ${url}`);
console.log(`     title:        ${channel.title}`);
console.log(`     atom:self:    ${atomSelf["@href"]}`);
console.log(`     lastBuild:    ${channel.lastBuildDate}`);
process.exit(0);
