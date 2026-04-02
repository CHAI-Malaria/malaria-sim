# Spatial Malaria Simulator

An interactive web-based spatial malaria transmission simulator. Generates random multi-patch landscapes, lets you design and compare intervention strategies (ITNs, IRS, CHWs, improved case management), and visualizes epidemiological and cost outcomes.

## How it works

The simulator runs entirely in the browser — no server required. It implements:

- **Ross-Macdonald ODE dynamics** across connected patches, with spatial coupling via human movement (gravity model) and mosquito dispersal
- **ITN + IRS combined effects** using the Le Menach feeding cycle model with phi_bednets correction (calibrated against Imperial's malariasimulation)
- **Case management cascade**: symptomatic fraction → care-seeking → facility access → cure rate, modified by CHW deployment and supply chain improvements
- **Procedural landscape generation** with five patch archetypes (swamp, lakeside, inland, market town, hill village) and an external importation zone

Based on the mathematical framework in Wu SL et al. (2023), *PLoS Computational Biology*.

## Local development

```bash
npm install
npm run dev
```

Then open http://localhost:5173/malaria-sim/

## Deployment

This repo includes a GitHub Actions workflow that automatically builds and deploys to GitHub Pages on every push to `main`.

To set up:

1. Push this repo to GitHub
2. Go to **Settings → Pages → Source** and select **GitHub Actions**
3. The site will be live at `https://YOUR_USERNAME.github.io/malaria-sim/`

> **Note:** If your repo name is different from `malaria-sim`, update the `base` path in `vite.config.js` to match.
