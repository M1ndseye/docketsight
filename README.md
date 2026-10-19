# DocketSight — Court Case Search, powered by M1ndseye

Frontend Simplified JavaScript final project. Searches U.S. federal and state court opinions and dockets with the [CourtListener API](https://www.courtlistener.com/help/api/rest/).

## Features
- Semantic HTML: nav, main, footer
- Live search against the CourtListener v4 Search API (opinions or federal dockets)
- Results rendered dynamically as cards
- Filters (all applied by the API): state, court level, court, case stage (new & open / open / closed), nature of suit, cause, judge
- Law firms and attorneys of record on each case, with an "Only cases with a law firm listed" filter
- Export leads: download the loaded cases as a CSV (firms, attorneys, case, court, judge, nature of suit, cause, jury demand, dates, link)
- "New & open" = filed in the last 90 days and not yet closed — the best available signal for cases that are just getting started
- Load more results (follows the API's next page)
- Sort: name A–Z, Z–A, newest first, oldest first
- Loading spinner and clear error messages
- Responsive on desktop and mobile

## Sample mode & tokens
- With no token, DocketSight runs in sample mode on a snapshot of real dockets (`demo-data.js`).
- Visitors connect their own free CourtListener token in the page; it's stored only in their browser (localStorage) and sent only to CourtListener.

## Setup
1. Get a free API token at courtlistener.com → Profile → Developer Tools → Your API Token.
2. Open `index.html` and paste the token into the box at the top (or, for local testing, copy `config.example.js` to `config.js`).

`config.js` is in `.gitignore`, so the token never gets pushed to GitHub.

## M1ndseye
DocketSight is a free tool from M1ndseye International LLC, makers of trial-ready 3D animation and demonstratives. Cases involving injuries, products, crashes and patents show a "Visualize this case in 3D" link.
