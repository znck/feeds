/**
 * RSS Feed Builder
 *
 * Reads feeds.json for configuration and the corresponding article
 * databases, then generates RSS/Atom/JSON feed files for each source.
 */

import { Feed } from "feed";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS_DIR = join(ROOT, "docs");
const FEEDS_CONFIG_PATH = join(ROOT, "feeds.json");

const SITE_URL = "https://znck.github.io/feeds";

async function buildFeed(config) {
  const articlesPath = join(ROOT, "data", `${config.slug}.json`);
  const articles = JSON.parse(await readFile(articlesPath, "utf-8"));
  console.log(
    `Building ${config.slug} feed from ${articles.length} articles.`
  );

  const feed = new Feed({
    title: config.title,
    description: config.description,
    id: `${SITE_URL}/${config.slug}.xml`,
    link: config.link,
    language: "en",
    favicon: new URL("/favicon.ico", config.link).href,
    copyright: config.copyright,
    updated: new Date(),
    feedLinks: {
      rss2: `${SITE_URL}/${config.slug}.xml`,
      atom: `${SITE_URL}/${config.slug}.atom`,
    },
    author: config.author,
  });

  for (const article of articles) {
    feed.addItem({
      title: article.title,
      id: article.url,
      link: article.url,
      description: article.description || "",
      date: article.date
        ? new Date(article.date)
        : new Date(article.discoveredAt || Date.now()),
      ...(article.image && {
        image: article.image,
      }),
    });
  }

  await writeFile(join(DOCS_DIR, `${config.slug}.xml`), feed.rss2());
  console.log(`Written: ${config.slug}.xml (RSS 2.0)`);

  await writeFile(join(DOCS_DIR, `${config.slug}.atom`), feed.atom1());
  console.log(`Written: ${config.slug}.atom (Atom)`);

  await writeFile(join(DOCS_DIR, `${config.slug}.json`), feed.json1());
  console.log(`Written: ${config.slug}.json (JSON Feed)`);
}

async function main() {
  await mkdir(DOCS_DIR, { recursive: true });

  const feeds = JSON.parse(await readFile(FEEDS_CONFIG_PATH, "utf-8"));

  for (const config of feeds) {
    await buildFeed(config);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
