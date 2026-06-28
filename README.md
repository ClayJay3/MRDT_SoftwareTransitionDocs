# MRDT Software Bible

The transition documentation site for the Mars Rover Design Team's Software Architect, built with [Docusaurus](https://docusaurus.io/). It replaces the old single `SOFTWARE_ARCHITECT_TRANSITION.md` with a searchable, visual, interactive site.

## Run it with Docker (no Node needed)

```bash
docker compose up                  # live dev server → http://localhost:3000
                                   # edit any docs/*.mdx and the browser hot-reloads
docker compose --profile prod up   # production build via nginx → http://localhost:8080
```

## Run it locally (with Node)

You need **Node.js ≥ 18** (the site was built on Node 20).

```bash
npm install        # first time only
npm start          # dev server with hot reload → http://localhost:3000
```

## Build for production

```bash
npm run build      # static site → ./build
npm run serve      # preview the production build locally
```

## Where things live

| Path | What |
|---|---|
| `docs/` | All the content (MDX). Folders map to sidebar sections. |
| `sidebars.js` | The reading order / sidebar structure. |
| `docusaurus.config.js` | Site config (title, navbar, Mermaid, dark mode). |
| `src/data/network.js` | **Single source of truth** for the network - boards, IPs, VLANs, radios, switches. The interactive map *and* the reference tables both read from this. Update it here, nowhere else. |
| `src/components/visuals/` | Interactive React components (e.g. `NetworkTopology`). |

## How to add content

- A new page is just a `.mdx` file in `docs/<section>/`, plus an entry in `sidebars.js`.
- Diagrams: use ```` ```mermaid ```` fenced blocks (flowcharts, state diagrams, sequence diagrams, packet diagrams all work - Mermaid 11).
- Callout boxes: `:::tip`, `:::note`, `:::info`, `:::warning`, `:::danger` (must start at the beginning of a line - they don't nest inside list items).
- Cross-link other docs with the file path **including extension**, e.g. `[Roadmap](../roadmap/roadmap.mdx)`, so links survive slug changes.
- ⚠️ **MDX gotcha:** bare-URL autolinks like `<https://x.com>` break the build. Use `[text](https://x.com)`.

## Deploying (suggested)

This is set up to deploy to GitHub Pages under the `MissouriMRDT` org (see `organizationName`/`projectName` in the config). Either:
- `npm run deploy` (Docusaurus' built-in GitHub Pages publish), or
- wire a GitHub Action that runs `npm run build` and publishes `build/` - matching how `RoveSoDocs` / `docs.themrdt.org` already work.

