import dns from "node:dns/promises";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const MAX_URLS = 10;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MIN_TEXT_CHARS = 240;
const REQUEST_TIMEOUT_MS = 25_000;
const PAGE_TIMEOUT_MS = 45_000;
const USER_AGENT = "Kardashev Research Intelligence Web Importer/1.0";

function ipv4IsPrivate(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipIsPrivate(address) {
  const normalized = String(address || "").trim().toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) return ipv4IsPrivate(normalized);
  if (family !== 6) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return ipv4IsPrivate(mapped);
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export async function assertSafeWebUrl(rawUrl, dnsCache = new Map()) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("网页地址格式无效");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("网页导入仅支持 http 或 https 地址");
  }
  if (parsed.username || parsed.password) throw new Error("网页地址不能包含登录凭据");
  if (parsed.port && !new Set(["80", "443"]).has(parsed.port)) {
    throw new Error("网页导入仅允许标准 HTTP/HTTPS 端口");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("网页地址不能指向本机或内部网络");
  }

  const cacheKey = hostname;
  let addresses = dnsCache.get(cacheKey);
  if (!addresses) {
    const literalFamily = net.isIP(hostname);
    addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await dns.lookup(hostname, { all: true });
    dnsCache.set(cacheKey, addresses);
  }
  if (!addresses.length || addresses.some((entry) => ipIsPrivate(entry.address))) {
    throw new Error("网页地址解析到了本机、私网或保留地址");
  }
  return parsed;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMarkdown(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export function extractReadableContent(html, url, extractionMethod = "static") {
  if (Buffer.byteLength(String(html || ""), "utf8") > MAX_HTML_BYTES) {
    throw new Error("网页 DOM 过大，无法安全提取正文");
  }
  const dom = new JSDOM(String(html || ""), { url, contentType: "text/html" });
  try {
    const document = dom.window.document;
    const parsed = new Readability(document.cloneNode(true), {
      charThreshold: MIN_TEXT_CHARS,
      keepClasses: false,
    }).parse();
    const text = normalizeText(parsed?.textContent || "");
    if (!parsed || text.length < MIN_TEXT_CHARS) {
      throw new Error(`未提取到足够的网页正文（至少 ${MIN_TEXT_CHARS} 个字符）`);
    }

    const purify = createDOMPurify(dom.window);
    const cleanHtml = purify.sanitize(parsed.content || "", {
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style", "srcset"],
    });
    const turndown = new TurndownService({
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      headingStyle: "atx",
    });
    turndown.remove(["script", "style", "iframe", "object", "embed", "form", "button", "noscript"]);
    const markdown = normalizeMarkdown(turndown.turndown(cleanHtml));
    if (normalizeText(markdown).length < MIN_TEXT_CHARS) {
      throw new Error("网页正文清洗后内容过少");
    }
    return {
      title: normalizeText(parsed.title || document.title || "").slice(0, 500),
      byline: normalizeText(parsed.byline || "").slice(0, 500),
      excerpt: normalizeText(parsed.excerpt || "").slice(0, 2000),
      site_name: normalizeText(parsed.siteName || "").slice(0, 300),
      lang: normalizeText(parsed.lang || document.documentElement.lang || "").slice(0, 40),
      markdown,
      text: text.slice(0, MAX_TEXT_CHARS),
      extraction_method: extractionMethod,
    };
  } finally {
    dom.window.close();
  }
}

async function fetchStaticHtml(rawUrl, dnsCache) {
  let current = await assertSafeWebUrl(rawUrl, dnsCache);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": USER_AGENT,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`网页返回了无目标的重定向（HTTP ${response.status}）`);
      current = await assertSafeWebUrl(new URL(location, current).toString(), dnsCache);
      continue;
    }
    if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("html") && !contentType.includes("xhtml")) {
      throw new Error(`该地址不是 HTML 网页（${contentType.split(";")[0]}）`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_HTML_BYTES) throw new Error("网页响应过大，无法安全提取正文");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_HTML_BYTES) throw new Error("网页响应过大，无法安全提取正文");
    return { html: bytes.toString("utf8"), finalUrl: current.toString() };
  }
  throw new Error("网页重定向次数过多");
}

async function extractWithBrowser(browser, rawUrl, dnsCache) {
  const context = await browser.newContext({
    acceptDownloads: false,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();
  try {
    await page.route("**/*", async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      if (["image", "media", "font", "websocket"].includes(resourceType)) {
        await route.abort();
        return;
      }
      const requestUrl = request.url();
      if (/^(data:|blob:|about:)/i.test(requestUrl)) {
        await route.continue();
        return;
      }
      try {
        await assertSafeWebUrl(requestUrl, dnsCache);
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    if (!response) throw new Error("浏览器未收到网页响应");
    if (!response.ok()) throw new Error(`网页请求失败（HTTP ${response.status()}）`);
    const finalUrl = page.url();
    await assertSafeWebUrl(finalUrl, dnsCache);

    let stableCount = 0;
    let previousLength = 0;
    for (let attempt = 0; attempt < 6 && stableCount < 2; attempt += 1) {
      await page.waitForTimeout(attempt === 0 ? 1200 : 700);
      const length = await page.locator("body").innerText({ timeout: 5000 }).then((value) => value.length).catch(() => 0);
      if (Math.abs(length - previousLength) < 80 && length >= MIN_TEXT_CHARS) stableCount += 1;
      else stableCount = 0;
      previousLength = length;
      if (attempt < 3) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    }
    const html = await page.content();
    return { ...extractReadableContent(html, finalUrl, "playwright"), final_url: finalUrl };
  } finally {
    await context.close();
  }
}

function normalizeUrls(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  const urls = [];
  const seen = new Set();
  for (const value of values) {
    const url = String(value || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (!urls.length) throw new Error("至少需要一个网页地址");
  if (urls.length > MAX_URLS) throw new Error(`一次最多导入 ${MAX_URLS} 个网页`);
  return urls;
}

export async function extractWebBatch(payload) {
  const urls = normalizeUrls(payload?.urls);
  const dnsCache = new Map();
  const results = [];
  let browser = null;
  try {
    for (const url of urls) {
      let staticError = "";
      try {
        const page = await fetchStaticHtml(url, dnsCache);
        results.push({
          ok: true,
          url,
          final_url: page.finalUrl,
          ...extractReadableContent(page.html, page.finalUrl, "static"),
        });
        continue;
      } catch (error) {
        staticError = error instanceof Error ? error.message : String(error);
      }

      try {
        await assertSafeWebUrl(url, dnsCache);
        if (!browser) {
          const { chromium } = await import("playwright");
          browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
        }
        const extracted = await extractWithBrowser(browser, url, dnsCache);
        results.push({ ok: true, url, ...extracted });
      } catch (error) {
        const dynamicError = error instanceof Error ? error.message : String(error);
        results.push({ ok: false, url, error: `静态提取失败：${staticError}；动态提取失败：${dynamicError}` });
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return { ok: results.some((item) => item.ok), results };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(`${JSON.stringify(await extractWebBatch(payload))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results: [] })}\n`);
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) await main();
