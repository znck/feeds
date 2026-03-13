# RSS Feeds

Unofficial RSS feeds for engineering blogs that don't offer their own. Updated automatically every 6 hours via GitHub Actions.

## Feeds

| Blog | RSS | Atom | JSON Feed |
|------|-----|------|-----------|
| [Anthropic Engineering](https://www.anthropic.com/engineering) | [RSS](https://znck.github.io/feeds/anthropic-engineering.xml) | [Atom](https://znck.github.io/feeds/anthropic-engineering.atom) | [JSON](https://znck.github.io/feeds/anthropic-engineering.json) |

## How it works

1. A crawler fetches the blog listing page and extracts article metadata
2. New articles are enriched by fetching individual pages for dates, descriptions, and images
3. Articles are stored incrementally in `data/articles.json`
4. RSS 2.0, Atom, and JSON Feed files are generated into `docs/`
5. GitHub Actions commits any changes and GitHub Pages serves the feeds

## Read with Foveate

Looking for an RSS reader? [Foveate](https://znck.dev/apps/foveate/) is an iOS app with AI-powered summaries and a built-in speed reader. No ads, no tracking, no subscriptions.

[![Download on the App Store](https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg)](https://apps.apple.com/us/app/foveate/id6759173368)

## Local development

```bash
npm install
npm run crawl   # Fetch and update articles
npm run build   # Generate feed files
```

## License

MIT
