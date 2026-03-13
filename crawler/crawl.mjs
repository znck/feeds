/**
 * RSS Feed Crawler for Anthropic Engineering Blog
 *
 * Fetches the blog listing page, extracts article metadata, and
 * incrementally updates the local articles database. New articles
 * are enriched by fetching their individual pages for full descriptions.
 */

import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARTICLES_PATH = join(ROOT, "data", "articles.json");

const BLOG_URL = "https://www.anthropic.com/engineering";
const BASE_URL = "https://www.anthropic.com";

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
 * Parses the engineering blog listing page and extracts article metadata.
 */
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const articles = [];

  // Find all links to /engineering/* articles
  $('a[href*="/engineering/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href === "/engineering" || href === "/engineering/")
      return;

    // Normalize URL
    const url = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const slug = href.replace(/^\/engineering\//, "").replace(/\/$/, "");

    // Skip if already collected (dedup by slug)
    if (articles.some((a) => a.slug === slug)) return;

    // Walk up to find the card container and extract text
    const card = $(el).closest(
      'div, article, li, [class*="card"], [class*="article"], [class*="post"]'
    );
    const container = card.length ? card : $(el);

    // Extract title - prefer heading tags, fallback to link text
    let title = "";
    const heading = container.find("h1, h2, h3, h4").first();
    if (heading.length) {
      title = heading.text().trim();
    }
    if (!title) {
      title = $(el).text().trim();
    }

    // Skip non-article links (navigation, etc.)
    if (!title || title.length < 5) return;

    // Extract description
    let description = "";
    const para = container.find("p").first();
    if (para.length) {
      description = para.text().trim();
    }

    articles.push({ slug, url, title, description });
  });

  return articles;
}

/**
 * Fetches an individual article page to extract full metadata.
 */
async function enrichArticle(article) {
  try {
    const html = await fetchWithRetry(article.url);
    const $ = cheerio.load(html);

    // Try to extract date from meta tags or page content
    const dateSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'time[datetime]',
    ];

    let date = null;
    for (const sel of dateSelectors) {
      const el = $(sel);
      if (el.length) {
        date = el.attr("content") || el.attr("datetime");
        if (date) break;
      }
    }

    // Fallback: look for date patterns in text
    if (!date) {
      const text = $("body").text();
      const dateMatch = text.match(
        /(?:Published|Posted)\s+(\w+ \d{1,2},?\s*\d{4})/i
      );
      if (dateMatch) {
        date = new Date(dateMatch[1]).toISOString();
      }
    }

    // Try to get a better description from meta tags
    const metaDesc =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content");

    if (metaDesc && metaDesc.length > (article.description?.length || 0)) {
      article.description = metaDesc;
    }

    // Get OG image
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      article.image = ogImage;
    }

    if (date) {
      article.date = date;
    }
  } catch (err) {
    console.warn(`Failed to enrich ${article.url}: ${err.message}`);
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
      bySlug.set(article.slug, { ...article, discoveredAt: new Date().toISOString() });
    } else {
      // Update description if the new one is longer/better
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
  console.log("Fetching engineering blog listing...");
  const html = await fetchWithRetry(BLOG_URL);
  const discovered = parseListingPage(html);
  console.log(`Found ${discovered.length} articles on listing page.`);

  const existing = await loadExistingArticles();
  console.log(`${existing.length} articles in local database.`);

  // Find truly new articles
  const existingSlugs = new Set(existing.map((a) => a.slug));
  const newArticles = discovered.filter((a) => !existingSlugs.has(a.slug));
  console.log(`${newArticles.length} new articles to enrich.`);

  // Enrich new articles with full metadata
  for (const article of newArticles) {
    console.log(`  Enriching: ${article.title}`);
    await enrichArticle(article);
    // Be polite - small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  // Also enrich existing articles that are missing dates
  const needsEnrichment = existing.filter((a) => !a.date);
  if (needsEnrichment.length > 0) {
    console.log(
      `${needsEnrichment.length} existing articles need date enrichment.`
    );
    for (const article of needsEnrichment) {
      console.log(`  Enriching: ${article.title}`);
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
