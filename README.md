# Auttanop Thongmark — Portfolio Site

A static, single-page site (resume, portfolio, and case studies). All media
(images, video, audio) live in `assets/` as real files — nothing is
base64-embedded anymore, so this loads fast and is easy to edit.

## Deploy to Netlify

**Fastest way (drag and drop):**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder (the one containing `index.html` and `assets/`) onto the page
3. Netlify gives you a live URL immediately

**With a Netlify account (recommended, gives you a stable site + easy redeploys):**
1. Sign in at https://app.netlify.com
2. "Add new site" → "Deploy manually"
3. Drag this folder in the same way
4. Optional: connect a custom domain under Site settings → Domain management

**Via Git (best for ongoing edits):**
1. Push this folder to a GitHub/GitLab repo
2. In Netlify: "Add new site" → "Import an existing project" → connect the repo
3. Build command: none needed (leave blank)
4. Publish directory: `.` (the repo root, since `index.html` is at the top level)

## Structure

```
index.html        - the whole site (home, resume, portfolio, case studies)
assets/           - all images, the promo video, and the two call recordings
README.md         - this file
```

## Editing later

Open `index.html` in any text editor. It's plain HTML/CSS/JS, no build step,
no dependencies beyond two Google Fonts loaded from a CDN link in the `<head>`.
