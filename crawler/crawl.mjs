/**
 * Generic Webpage-to-RSS Crawler
 *
 * Discovers articles from any website using one of two methods:
 *   - "html":    Parse a listing page for links matching a pattern
 *   - "sitemap": Parse a sitemap XML for article URLs
 *
 * Then enriches new articles in parallel by fetching just the <head>
 * of each page for SEO metadata (og:title, og:description, dates, og:image).
 *
 * Configuration is read from feeds.json. Run a specific feed with:
 *   node crawler/crawl.mjs <slug>
 * Or crawl all feeds:
 *   node crawler/crawl.mjs
 */

import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FEEDS_CONFIG_PATH = join(ROOT, "feeds.json");

const CONCURRENCY = 10;

// --- Shared utilities ---

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; RSS-Feed-Crawler/1.0; +https://github.com/znck/feeds)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
      if (res.status === 403 || res.status === 429) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw err;
      const delay = Math.pow(2, i + 1) * 1000;
      console.warn(`Retry ${i + 1} for ${url} in ${delay}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function runInParallel(items, fn, concurrency = CONCURRENCY) {
  const results = [];
  let index = 0;
  let limit = concurrency;

  async function worker(id) {
    while (index < items.length) {
      if (id >= limit) return;
      const i = index++;
      results[i] = await fn(items[i], {
        throttle() {
          limit = Math.max(1, Math.floor(limit / 2));
          console.warn(`Throttling — concurrency now ${limit}`);
        },
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, (_, id) =>
      worker(id)
    )
  );
  return results;
}

function tryParseDate(val) {
  const date = new Date(val);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function slugFromUrl(url) {
  const path = new URL(url).pathname.replace(/\/$/, "");
  return path.split("/").pop();
}

/**
 * Extract just the <head> content from HTML to avoid parsing large bodies.
 */
function extractHead(html) {
  const headEnd = html.indexOf("</head>");
  if (headEnd !== -1) {
    return html.slice(0, headEnd + 7);
  }
  return html;
}

// --- Discovery methods ---

function discoverFromHtml(html, config) {
  const $ = cheerio.load(html);
  const articles = [];
  const pattern = new RegExp(config.discovery.linkPattern);

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !pattern.test(href)) return;

    const url = new URL(href, config.discovery.url).href;
    const slug = slugFromUrl(url);

    if (!slug || articles.some((a) => a.slug === slug)) return;

    // Walk up to find the card container
    const card = $(el).closest(
      'div, article, li, [class*="card"], [class*="article"], [class*="post"]'
    );
    const container = card.length ? card : $(el);

    // Extract title
    let title = "";
    const heading = container.find("h1, h2, h3, h4").first();
    if (heading.length) title = heading.text().trim();
    if (!title) title = $(el).text().trim();
    if (!title || title.length < 5) return;

    // Extract description
    let description = "";
    const para = container.find("p").first();
    if (para.length) description = para.text().trim();

    articles.push({ slug, url, title, description });
  });

  return articles;
}

function discoverFromSitemap(xml, config) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles = [];
  const pattern = config.discovery.linkPattern
    ? new RegExp(config.discovery.linkPattern)
    : null;

  $("url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    if (!loc) return;
    if (pattern && !pattern.test(loc)) return;

    const slug = slugFromUrl(loc);
    if (!slug) return;

    articles.push({ slug, url: loc });
  });

  return articles;
}

// --- Enrichment ---

function enrichFromHead($, article) {
  // Title
  if (!article.title) {
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const pageTitle = $("title").text().replace(/\s*\|.*$/, "").trim();
    article.title = ogTitle || pageTitle || "";
  }

  // Description — keep the longer one
  const ogDesc = $('meta[property="og:description"]').attr("content");
  const metaDesc = $('meta[name="description"]').attr("content");
  const bestDesc = ogDesc || metaDesc || "";
  if (bestDesc.length > (article.description?.length || 0)) {
    article.description = bestDesc;
  }

  // Date — try multiple sources in <head>
  if (!article.date) {
    const dateSelectors = [
      { sel: 'meta[property="article:published_time"]', attr: "content" },
      { sel: 'meta[name="date"]', attr: "content" },
      { sel: "time[datetime]", attr: "datetime" },
    ];
    for (const { sel, attr } of dateSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const val = el.attr(attr);
        if (val) {
          const parsed = tryParseDate(val);
          if (parsed) {
            article.date = parsed;
            break;
          }
        }
      }
    }
  }

  // Image
  if (!article.image) {
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) article.image = ogImage;
  }
}

async function enrichArticle(article, { throttle } = {}) {
  try {
    const html = await fetchWithRetry(article.url);
    const head = extractHead(html);
    const $ = cheerio.load(head);
    enrichFromHead($, article);
  } catch (err) {
    if ((err.status === 403 || err.status === 429) && throttle) throttle();
    console.warn(`  Failed to enrich ${article.url}: ${err.message}`);
  }

  // Fallback title from slug
  if (!article.title) {
    article.title = article.slug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return article;
}

// --- Data management ---

async function loadArticles(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return [];
  }
}

function mergeArticles(existing, discovered) {
  const bySlug = new Map(existing.map((a) => [a.slug, a]));

  for (const article of discovered) {
    if (!bySlug.has(article.slug)) {
      bySlug.set(article.slug, {
        ...article,
        discoveredAt: new Date().toISOString(),
      });
    } else {
      const prev = bySlug.get(article.slug);
      if (
        article.description &&
        article.description.length > (prev.description?.length || 0)
      ) {
        prev.description = article.description;
      }
    }
  }

  return Array.from(bySlug.values());
}

// --- Main ---

async function crawlFeed(config) {
  const dataPath = join(ROOT, "data", `${config.slug}.json`);

  console.log(`\n--- Crawling: ${config.title} ---`);

  // Discover articles
  let discovered;
  const { method, url } = config.discovery;
  const content = await fetchWithRetry(url);

  if (method === "sitemap") {
    discovered = discoverFromSitemap(content, config);
  } else {
    discovered = discoverFromHtml(content, config);
  }
  console.log(`Found ${discovered.length} articles.`);

  // Load existing
  const existing = await loadArticles(dataPath);
  console.log(`${existing.length} articles in local database.`);

  // Collect articles needing enrichment
  const existingSlugs = new Set(existing.map((a) => a.slug));
  const newArticles = discovered.filter((a) => !existingSlugs.has(a.slug));
  const needsEnrichment = existing.filter((a) => !a.date || !a.title);
  const toEnrich = [...newArticles, ...needsEnrichment];

  console.log(
    `Enriching ${toEnrich.length} articles (${newArticles.length} new, ${needsEnrichment.length} incomplete)...`
  );

  await runInParallel(toEnrich, async (article, ctx) => {
    console.log(`  Enriching: ${article.title || article.slug}`);
    return enrichArticle(article, ctx);
  });

  // Merge, sort, save
  let articles = mergeArticles(existing, discovered);
  articles.sort((a, b) => {
    if (a.date && b.date) return new Date(b.date) - new Date(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  await writeFile(dataPath, JSON.stringify(articles, null, 2) + "\n");
  console.log(`Saved ${articles.length} articles.`);
}

async function main() {
  const feeds = JSON.parse(await readFile(FEEDS_CONFIG_PATH, "utf-8"));
  const target = process.argv[2];

  const selected = target
    ? feeds.filter((f) => f.slug === target)
    : feeds;

  if (selected.length === 0) {
    console.error(`Unknown feed: ${target}`);
    console.error(`Available: ${feeds.map((f) => f.slug).join(", ")}`);
    process.exit(1);
  }

  await Promise.all(selected.map((config) => crawlFeed(config)));
}

main().catch((err) => {
  console.error("Crawl failed:", err);
  process.exit(1);
});
