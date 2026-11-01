# Measure Chart Builder (site)

Standalone version of the Measure Chart Builder, built to be embedded in the Squarespace member page.

- `public/index.html` is the whole app. It's built from `src/` (template.html, parser.js, analysis.js) by `python3 build_site.py`. `src/build.py` builds the claude.ai artifact version.
- `functions/api/songs/` is the song library API (Cloudflare Pages Functions + a D1 database).
- `schema.sql` creates the library table.
- `public/_headers` only lets the page be framed by your Squarespace site.

Changes from the artifact version:
- The song library is stored in your own database instead of the artifact's.
- Only editors can save to the library. Open the site once with `?editor=YOUR_KEY` on the end of the address and that browser stays an editor. Members can still use saved fixes.
- There are no download buttons (licensing).
- Audio is processed in the visitor's browser and never uploaded.

## One-time setup (Cloudflare Pages, free plan)

1. Put this folder in a GitHub repo.
2. Cloudflare dashboard: Workers & Pages, then Create, then Pages, then connect the repo.
   Build command: none. Output directory: `public`.
3. Storage & Databases, then D1, then Create database `measure-chart-library`.
   In its Console, paste the contents of `schema.sql` and run it.
4. In the Pages project: Settings, then Bindings, then add a D1 binding named `DB` pointing at that database.
5. Settings, then Variables and Secrets: add a secret `EDITOR_KEY` (any long password).
6. Edit `public/_headers`: replace `REPLACE_WITH_YOUR_SITE_DOMAIN` with your site address, e.g. `https://www.example.com`.
7. Squarespace member page: add a Code Block with
   ```html
   <iframe src="https://YOUR-PROJECT.pages.dev/" style="width:100%;height:90vh;border:0" allow="autoplay"></iframe>
   ```

## Known gaps
- The site address itself is not member-only yet: anyone who finds the pages.dev link can open it directly. Framing on other sites is blocked.
- Phase 2 (planned): a pay-per-use GPU server for real stem separation (vocals, piano) and chord recognition (pushes), keeping total processing under a minute.
