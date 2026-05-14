#!/usr/bin/env node
/**
 * End-to-end PostHog content-event verifier. Drives a real Chromium via
 * puppeteer-core, intercepts every /ingest POST the page makes, and asserts
 * the expected events fire on each surface:
 *
 *   /vs/<slug>            → comparison_viewed { slug, surface=web }
 *   /solutions/<slug>     → use_case_viewed   { slug, surface=web }
 *   /blog/<slug>          → blog_post_read    { slug, scroll_depth=25|50|75|100 }
 *   any [data-cta] click  → cta_clicked       { cta_id, source_page }
 *
 * The web app must be running on POSTHOG_VERIFY_BASE with
 * NEXT_PUBLIC_POSTHOG_KEY set to a non-empty value (any string) so the
 * PostHogProvider initializes the client.
 *
 * Usage:
 *   POSTHOG_VERIFY_BASE=http://localhost:3002 node scripts/posthog-verify.mjs
 */

import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const APP_BASE = process.env.POSTHOG_VERIFY_BASE ?? "http://localhost:3002";
const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = path.resolve(path.dirname(__filename), "..");

function findChromium() {
  const cacheDir = path.join(process.env.HOME, ".cache", "puppeteer", "chrome");
  if (fs.existsSync(cacheDir)) {
    const versions = fs.readdirSync(cacheDir).filter((d) => d.startsWith("mac_"));
    if (versions[0]) {
      const candidate = path.join(
        cacheDir,
        versions[0],
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const sys =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(sys)) return sys;
  return null;
}

async function importPuppeteerCore() {
  return import(
    "file://" +
      path.join(
        APP_ROOT,
        "..",
        "..",
        "node_modules",
        ".pnpm",
        "puppeteer-core@22.15.0",
        "node_modules",
        "puppeteer-core",
        "lib",
        "cjs",
        "puppeteer",
        "puppeteer-core.js",
      )
  );
}

/** Per-page singleton capture array, sliced from the offset returned by
 * markCapture(). */
function markCapture(page) {
  if (!page.__contentEventsCapture) {
    throw new Error("setupCapture(page) must be called before markCapture(page)");
  }
  return page.__contentEventsCapture.length;
}

function captureSince(page, offset) {
  return page.__contentEventsCapture.slice(offset);
}

/** Single request handler: stubs /ingest responses, captures POST bodies,
 * passes everything else through. Must be the only request handler under
 * setRequestInterception. */
function setupCapture(page) {
  /** @type {Array<{ url: string, body: string }>} */
  const reqs = [];
  page.__contentEventsCapture = reqs;

  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();
    if (process.env.POSTHOG_VERIFY_DEBUG && method === "POST") {
      console.log(`[req-all] POST ${url.slice(0, 120)}`);
    }
    if (url.includes("/ingest/") || url.includes("posthog")) {
      if (method === "POST") {
        const body = req.postData() ?? "";
        reqs.push({ url, body });
      }
      req
        .respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: 1,
            featureFlags: {},
            featureFlagPayloads: {},
          }),
        })
        .catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });
}

function decodeBody(url, body) {
  if (!body) return null;
  // PostHog uses several encodings:
  //  - compression=gzip-js → gzip-deflated JSON in postData
  //  - compression=base64 → "data=<base64-of-json>" in postData
  //  - no compression flag → JSON or "data=<base64>" form-encoded
  if (url.includes("compression=gzip-js")) {
    // postData() returns the body as a string. For gzip we need bytes.
    // Puppeteer gives us a UTF-8-decoded string; we recover bytes via Buffer.from(.., 'binary').
    try {
      const buf = Buffer.from(body, "binary");
      const inflated = zlib.gunzipSync(buf);
      return JSON.parse(inflated.toString("utf-8"));
    } catch {
      return null;
    }
  }
  // form-urlencoded "data=<base64-of-json>"
  if (body.startsWith("data=")) {
    try {
      const b64 = decodeURIComponent(body.slice(5));
      const json = Buffer.from(b64, "base64").toString("utf-8");
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  // raw JSON
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function eventsFromCapture(reqs) {
  const out = [];
  for (const r of reqs) {
    const parsed = decodeBody(r.url, r.body);
    if (!parsed) {
      if (process.env.POSTHOG_VERIFY_DEBUG) {
        console.log(
          `[decode-fail] url=${r.url.slice(0, 80)}  bodyLen=${(r.body ?? "").length}`,
        );
      }
      continue;
    }
    const batch = Array.isArray(parsed) ? parsed : parsed.batch ?? [parsed];
    for (const e of batch) {
      if (e?.event) {
        if (process.env.POSTHOG_VERIFY_DEBUG) {
          console.log(`[decoded] ${e.event}  props=${JSON.stringify(e.properties ?? {}).slice(0, 100)}`);
        }
        out.push(e);
      }
    }
  }
  return out;
}

function expect(events, name, predicate) {
  const found = events.find(
    (e) => e.event === name && (predicate ? predicate(e.properties ?? {}) : true),
  );
  if (!found) {
    console.error(`  [FAIL] expected event "${name}" not seen`);
    return false;
  }
  console.log(
    `  [OK] ${name}  ${JSON.stringify(found.properties).slice(0, 110)}`,
  );
  return true;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** PostHog batches captures and only flushes on pagehide / interval. Force
 * an immediate flush so the test doesn't wait on the batch timer. */
async function flushPostHog(page) {
  try {
    await page.evaluate(async () => {
      // posthog-js registers itself on window after init().
      const ph = /** @type {any} */ (window).posthog;
      if (ph && typeof ph._send_request !== "undefined") {
        if (typeof ph.capture === "function") {
          // Trigger flush of any queued events.
          if (typeof ph._flush === "function") ph._flush();
        }
      }
    });
  } catch {
    /* ignore */
  }
}

async function main() {
  const chromium = findChromium();
  if (!chromium) {
    console.error("No Chrome/Chromium found");
    process.exit(2);
  }
  console.log(`[info] chromium: ${chromium}`);

  const pup = await importPuppeteerCore();
  const browser = await pup.default.launch({
    executablePath: chromium,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let allOk = true;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // PostHog auto-disables itself on user-agents containing "HeadlessChrome"
    // (bot detection). Spoof a regular Chrome UA so events actually fire.
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    );
    // PostHog ALSO checks navigator.webdriver and various automation tells.
    // Strip them on every new document.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
        configurable: true,
      });
      // Some bot detectors look for plugins / languages absence.
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
        configurable: true,
      });
      // window.chrome presence is a non-bot tell.
      // @ts-expect-error spoofing
      window.chrome = window.chrome ?? { runtime: {}, loadTimes: () => {}, csi: () => {} };
    });

    // Stub /ingest/* responses so PostHog sees a successful flag-decide call
    // and stops gating event capture, while capturing every POST body.
    // Single handler under setRequestInterception — multiple handlers fight
    // each other and silently break navigation.
    await page.setRequestInterception(true);
    setupCapture(page);

    // Diagnostic: page console only — request listeners conflict with
    // interception and can't be added separately.
    if (process.env.POSTHOG_VERIFY_DEBUG) {
      page.on("response", (res) => {
        if (res.request().method() === "POST") {
          console.log(`[res] ${res.status()} ${res.url().slice(0, 100)}`);
        }
      });
      page.on("console", (msg) => {
        const t = msg.type();
        if (t === "log" || t === "error" || t === "warning") {
          console.log(`[page-${t}] ${msg.text()}`);
        }
      });
      page.on("pageerror", (err) => {
        console.log(`[page-error] ${err.message}`);
      });
    }

    // 1. /vs/<slug> → comparison_viewed.
    // PostHog batches captures and flushes on pagehide. After each case we
    // navigate to about:blank so the queued events flush via pagehide and
    // land in our request capture before we assert.
    console.log("\n[case] comparison_viewed");
    {
      const offset = markCapture(page);
      await page.goto(`${APP_BASE}/vs/claude-code-vs-cursor`, {
        waitUntil: "domcontentloaded",
      });
      await wait(1500);
      await page.goto("about:blank");
      await wait(500);
      const events = eventsFromCapture(captureSince(page, offset));
      const ok = expect(
        events,
        "comparison_viewed",
        (p) => p.slug === "claude-code-vs-cursor" && p.surface === "web",
      );
      allOk = allOk && ok;
    }

    // 2. /solutions/<slug> → use_case_viewed.
    console.log("\n[case] use_case_viewed");
    {
      const offset = markCapture(page);
      await page.goto(`${APP_BASE}/solutions/run-claude-code-in-cloud`, {
        waitUntil: "domcontentloaded",
      });
      await wait(1500);
      await page.goto("about:blank");
      await wait(500);
      const events = eventsFromCapture(captureSince(page, offset));
      const ok = expect(
        events,
        "use_case_viewed",
        (p) => p.slug === "run-claude-code-in-cloud" && p.surface === "web",
      );
      allOk = allOk && ok;
    }

    // 3. /blog/<slug> with scroll → blog_post_read at multiple depths.
    console.log("\n[case] blog_post_read with scroll depths");
    {
      const offset = markCapture(page);
      await page.goto(`${APP_BASE}/blog/claude-code-vs-cursor`, {
        waitUntil: "domcontentloaded",
      });
      await wait(1000);
      for (const frac of [0.3, 0.55, 0.78, 1.0]) {
        await page.evaluate((f) => {
          window.scrollTo(0, document.documentElement.scrollHeight * f);
        }, frac);
        await wait(400);
      }
      await wait(800);
      await page.goto("about:blank");
      await wait(700);
      const events = eventsFromCapture(captureSince(page, offset));
      const reads = events.filter((e) => e.event === "blog_post_read");
      const depths = new Set(
        reads.map((e) => e.properties?.scroll_depth),
      );
      let allDepths = true;
      for (const d of ["25", "50", "75", "100"]) {
        if (!depths.has(d)) {
          console.error(`  [FAIL] missing blog_post_read at depth ${d}`);
          allDepths = false;
        } else {
          console.log(`  [OK] blog_post_read scroll_depth=${d}`);
        }
      }
      allOk = allOk && allDepths;
    }

    // 4. CTA click → cta_clicked. We strip the href on the CTA so the page
    // doesn't navigate before posthog flushes via about:blank pagehide.
    console.log("\n[case] cta_clicked on a [data-cta] anchor");
    {
      const offset = markCapture(page);
      await page.goto(`${APP_BASE}/vs/claude-code-vs-cursor`, {
        waitUntil: "domcontentloaded",
      });
      await wait(1200);
      const before = markCapture(page);
      const present = await page.evaluate(() => {
        const cta = document.querySelector('[data-cta="comparison-signup"]');
        if (!(cta instanceof HTMLAnchorElement)) return false;
        cta.removeAttribute("href");
        cta.click();
        return true;
      });
      if (!present) {
        console.error('  [FAIL] [data-cta="comparison-signup"] not in DOM');
        allOk = false;
      } else {
        await wait(800);
        await page.goto("about:blank");
        await wait(700);
        const events = eventsFromCapture(captureSince(page, before));
        const ok = expect(
          events,
          "cta_clicked",
          (p) =>
            p.cta_id === "comparison-signup" &&
            (p.source_page ?? "").includes("/vs/claude-code-vs-cursor"),
        );
        allOk = allOk && ok;
      }
    }
  } finally {
    await browser.close();
  }

  if (!allOk) {
    console.error("\n[FAIL] one or more events did not fire");
    process.exit(1);
  }
  console.log("\n[OK] all PostHog content events verified end-to-end");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
