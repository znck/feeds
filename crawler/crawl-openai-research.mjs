/**
 * RSS Feed Crawler for OpenAI Research Index
 *
 * Discovers articles from the sitemap and enriches them by fetching
 * individual pages for metadata (title, description, date).
 */

import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARTICLES_PATH = join(ROOT, "data", "openai-research.json");

const SITEMAP_URL = "https://openai.com/sitemap.xml/research/";
const BASE_URL = "https://openai.com";

/**
 * Fetches a URL with retries and exponential backoff.
 */
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "RSS-Feed-Crawler/1.0 (+https://github.com/znck/feeds)",
        },
      });
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

/**
 * Parses the sitemap XML and extracts article URLs.
 */
function parseSitemap(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles = [];

  $("url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    if (!loc) return;

    // Extract slug from URL
    const match = loc.match(/\/index\/([^/]+)\/?$/);
    if (!match) return;

    const slug = match[1];
    articles.push({ slug, url: loc });
  });

  return articles;
}

/**
 * Fetches an individual article page to extract metadata.
 */
async function enrichArticle(article) {
  try {
    const html = await fetchWithRetry(article.url);
    const $ = cheerio.load(html);

    // Extract title from og:title or page title
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const pageTitle = $("title").text().replace(/\s*\|.*$/, "").trim();
    article.title = ogTitle || pageTitle || article.slug;

    // Extract description from meta tags
    const ogDesc = $('meta[property="og:description"]').attr("content");
    const metaDesc = $('meta[name="description"]').attr("content");
    article.description = ogDesc || metaDesc || "";

    // Extract date from <time> element or meta tags
    const timeEl = $("time[dateTime]").first();
    if (timeEl.length) {
      article.date = new Date(timeEl.attr("dateTime")).toISOString();
    } else {
      const dateSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="date"]',
      ];
      for (const sel of dateSelectors) {
        const el = $(sel);
        if (el.length) {
          const val = el.attr("content");
          if (val) {
            article.date = new Date(val).toISOString();
            break;
          }
        }
      }
    }

    // Extract OG image
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      article.image = ogImage;
    }
  } catch (err) {
    console.warn(`Failed to enrich ${article.url}: ${err.message}`);
    // Use slug as fallback title
    if (!article.title) {
      article.title = article.slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return article;
}

/**
 * Loads existing articles from the data file.
 */
async function loadExistingArticles() {
  try {
    const data = await readFile(ARTICLES_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Merges new articles into the existing list, preserving existing data.
 */
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

async function main() {
  console.log("Fetching OpenAI research sitemap...");
  const xml = await fetchWithRetry(SITEMAP_URL);
  const discovered = parseSitemap(xml);
  console.log(`Found ${discovered.length} articles in sitemap.`);

  const existing = await loadExistingArticles();
  console.log(`${existing.length} articles in local database.`);

  // Find truly new articles
  const existingSlugs = new Set(existing.map((a) => a.slug));
  const newArticles = discovered.filter((a) => !existingSlugs.has(a.slug));
  console.log(`${newArticles.length} new articles to enrich.`);

  // Enrich new articles with full metadata
  for (const article of newArticles) {
    console.log(`  Enriching: ${article.slug}`);
    await enrichArticle(article);
    // Be polite - small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  // Also enrich existing articles that are missing dates or titles
  const needsEnrichment = existing.filter((a) => !a.date || !a.title);
  if (needsEnrichment.length > 0) {
    console.log(
      `${needsEnrichment.length} existing articles need enrichment.`
    );
    for (const article of needsEnrichment) {
      console.log(`  Enriching: ${article.slug}`);
      await enrichArticle(article);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Merge and sort
  let articles = mergeArticles(existing, discovered);
  articles.sort((a, b) => {
    if (a.date && b.date) return new Date(b.date) - new Date(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  // Save
  await writeFile(ARTICLES_PATH, JSON.stringify(articles, null, 2) + "\n");
  console.log(`Saved ${articles.length} articles to database.`);

  return articles;
}

main().catch((err) => {
  console.error("Crawl failed:", err);
  process.exit(1);
});
