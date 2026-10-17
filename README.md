# Brockton Safety Log

A phone-friendly map and list of calls from the Brockton Police dispatch log.

A GitHub Action runs every 6 hours. It:
1. Checks https://www.brocktonpolice.com/category/police-log/ for new log PDFs.
2. Parses them (`src/parse.js`). Only call type, time, action, and a block-level location are kept. Names and arrest or summons details are discarded.
3. Looks up map coordinates for priority calls (shots/weapons, violence, fire, crashes).
4. Saves `public/data/calls.json`, builds the site, and publishes it with GitHub Pages.

## One-time setup

1. Create a **public** repository and add these files.
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Open the **Actions** tab, choose **Update police log data and publish**, and press **Run workflow**.
4. When it finishes, the site address appears in the run summary and under Settings > Pages.

## Notes

- The department posts logs every week or two, so data runs a few days to two weeks behind.
- The first run looks up locations in batches (300 per run), so the map fills in over a day or two.
- If the department changes its PDF format, `npm test -- path/to/log.pdf` shows what the parser sees.
- GitHub may pause scheduled runs after 60 days with no repository activity. Press **Run workflow** to restart them.
