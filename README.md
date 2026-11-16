# Tonight

A calm little TV tracker: what you're watching, what's coming up, and what to watch next.

The app is the `docs/` folder — plain HTML, CSS and JavaScript, no build step. Show information
comes from the free [TVMaze](https://www.tvmaze.com/api) API, and everything you track is saved on
your own phone.

## Put it on your phone (one-time setup)

1. In this repo on GitHub: **Settings → General → Danger Zone → Change visibility → Public**
   (free GitHub Pages hosting needs a public repo; your watch list is never stored here).
2. **Settings → Pages → Source → GitHub Actions**.
3. **Actions → Publish Tonight → Run workflow**. After a minute the app is live at
   `https://cowperfay.github.io/blank-canvas/`.
4. Open that link in Chrome on your phone, tap **⋮ → Add to Home screen → Install**.

## How it stays up to date

- Episodes, air dates and new seasons for your shows are checked every time you open the app.
- Recommendations and upcoming premieres are rebuilt once a day by the **Publish Tonight** workflow
  (`scripts/build-data.mjs`).

## Run it locally

```
cd docs && python3 -m http.server 8000
```
