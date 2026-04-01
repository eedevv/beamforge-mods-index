# BeamForge Mod Index

Auto-updated daily metadata index for the [BeamForge](https://github.com/DecryptedM4/beamforge) mod manager.

## Structure

```
index.json              ← manifest with page counts and last-updated timestamp
beamng/page-N.json      ← BeamNG.com resources (50 mods per page)
modland/page-N.json     ← beamng-mods.net community mods (50 per page)
```

## Update cadence

GitHub Actions runs the scraper daily at 02:00 UTC. You can also trigger it manually via the **Actions** tab → **Scrape Mod Index** → **Run workflow**.

## Mod schema

Each entry in a page file follows the `BrowseResult` shape used by BeamForge:

```json
{
  "id": 12345,
  "source": "beamng",
  "title": "Mod Name",
  "author": "username",
  "version": "1.2.3",
  "downloadCount": 45000,
  "viewCount": 120000,
  "rating": 4.7,
  "ratingCount": 89,
  "categoryId": 2,
  "categoryTitle": "Vehicles",
  "description": "...",
  "tagLine": "...",
  "thumbnailUrl": "https://...",
  "downloadUrl": "https://www.beamng.com/resources/12345/download",
  "resourceUrl": "https://www.beamng.com/resources/mod-name.12345/",
  "lastUpdate": 1710000000,
  "postedDate": 1700000000,
  "requiresLogin": true
}
```
