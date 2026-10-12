# PDF Editor Pro

A free, private, browser-based **PDF editor** — view, edit, annotate, sign, merge, split,
reorder, rotate, compress and convert PDFs. Everything runs 100% in your browser. No uploads,
no accounts, no servers. Your files never leave your device.

Optional one-time **Pro** upgrade unlocks power features and removes the small export watermark.

---

## What this is

Same proven mechanics as the Invoice Generator: a fully-usable **free** tool with a diagonal
"Free version" watermark stamp on exported PDFs, plus a **$9 one-time Pro** upgrade (Gumroad
license key) that removes the watermark and unlocks advanced features.

- **Stack:** Plain HTML + CSS + JavaScript. No build step.
- **PDF engine:** [`pdf.js`](https://mozilla.github.io/pdf.js/) (render/view) + [`pdf-lib`](https://pdf-lib.js.org/) (edit/save) — loaded from CDN.
- **Storage:** Browser `localStorage` (license + preferences). PDF files stay in memory only.
- **Hosting:** GitHub Pages (free). **Cost: $0.**
- **Payments:** Gumroad digital product, one-time license key per sale.

---

## Status

**PLANNING + POC.** This folder currently contains:

| File | Purpose |
|------|---------|
| `README.md` | This overview |
| `FEATURES.md` | **Complete catalog of every PDF-editor feature**, split Free vs Pro, with implementation notes |
| `PLAN.md` | Phase-by-phase build plan (Phase 0 → Phase 9) |
| `MONEY-PLAN.md` | Monetization, pricing, licensing mechanics |
| `PROMOTION.md` | Launch + growth playbook |
| `index.html`, `styles.css`, `app.js` | **Working POC** — open a PDF, add text/annotations, reorder/rotate/delete pages, export |

> Review the docs from the ground up first. Nothing beyond the POC is implemented yet — the
> build phases in `PLAN.md` are the agreed roadmap we'll pick from together.

---

## Try the POC (right now, locally)

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).
2. Drag a PDF onto the drop zone (or click **Open PDF**).
3. Use the toolbar to add a text box, highlight, or signature; reorder/rotate/delete pages in the sidebar.
4. Click **Download PDF** to export. (Free export includes a small watermark — Pro removes it.)

No internet is needed except the first load (to fetch the pdf.js / pdf-lib CDN scripts).

---

## Design principles

- **Privacy first** — files are processed locally in the browser and never uploaded. This is the #1 selling point vs. online converters.
- **Zero friction** — no login, no install, works on desktop and tablet.
- **Freemium honesty** — the free tier is genuinely useful; Pro is an upgrade, not a paywall on basics.
- **Reuse the playbook** — one `isPro()` gate, `activateLicense(key)` Promise, Gumroad verify, SEO + GA4, all mirrored from the Invoice Generator.
