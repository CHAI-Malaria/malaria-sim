import { useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from "recharts";

// ============================================================================
// MATH UTILITIES
// ============================================================================

// Seeded PRNG (xoshiro128**)
class PRNG {
  constructor(seed) {
    this.s = new Uint32Array(4);
    this.s[0] = seed ^ 0x12345678;
    this.s[1] = (seed * 1103515245 + 12345) >>> 0;
    this.s[2] = (seed * 214013 + 2531011) >>> 0;
    this.s[3] = (seed * 48271) >>> 0;
    for (let i = 0; i < 20; i++) this._next();
  }
  _next() {
    const s = this.s;
    const result = (s[1] * 5) | 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result >>> 0) / 4294967296;
  }
  random() { return this._next(); }
  normal(mu = 0, sigma = 1) {
    let u, v, s;
    do { u = 2 * this.random() - 1; v = 2 * this.random() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    return mu + sigma * u * Math.sqrt(-2 * Math.log(s) / s);
  }
  lognormal(mean, cv) {
    if (cv <= 0) return mean;
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(this.normal(mu, Math.sqrt(sigma2)));
  }
  beta(a, b) {
    const ga = this._gamma(a), gb = this._gamma(b);
    return ga / (ga + gb);
  }
  _gamma(alpha) {
    if (alpha < 1) return this._gamma(alpha + 1) * Math.pow(this.random(), 1 / alpha);
    const d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  betaMeanConc(mean, concentration) {
    mean = Math.max(0.01, Math.min(0.99, mean));
    return this.beta(mean * concentration, (1 - mean) * concentration);
  }
}

// Matrix-vector multiply
function matVecMul(A, x) {
  const n = x.length;
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) r[i] += A[i * n + j] * x[j];
  return r;
}

// Transpose matrix-vector multiply (A^T @ x)
function matTVecMul(A, x) {
  const n = x.length;
  const r = new Float64Array(n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) r[j] += A[i * n + j] * x[i];
  return r;
}

// ============================================================================
// ARCHETYPE DEFINITIONS
// ============================================================================

const ARCHETYPES = {
  swamp: { label: "Swamp Settlement", popMean: 1000, popCv: 0.4, emergMean: 600, emergCv: 0.3, accessMean: 0.20, accessConc: 8, remoteMean: 1.8, symptMean: 0.20, symptConc: 15, careMean: 0.40, careConc: 12, xc: 0.3, yc: 0.15, spread: 0.12, attractBonus: 0, color: "#d95f02" },
  lakeside: { label: "Lakeside Village", popMean: 2000, popCv: 0.3, emergMean: 400, emergCv: 0.3, accessMean: 0.40, accessConc: 10, remoteMean: 1.3, symptMean: 0.25, symptConc: 15, careMean: 0.50, careConc: 12, xc: 0.4, yc: 0.25, spread: 0.15, attractBonus: 0, color: "#1b9e77" },
  inland: { label: "Inland Village", popMean: 3000, popCv: 0.35, emergMean: 200, emergCv: 0.35, accessMean: 0.50, accessConc: 10, remoteMean: 1.0, symptMean: 0.35, symptConc: 15, careMean: 0.50, careConc: 12, xc: 0.5, yc: 0.50, spread: 0.18, attractBonus: 0, color: "#7570b3" },
  market_town: { label: "Market Town", popMean: 5000, popCv: 0.3, emergMean: 160, emergCv: 0.3, accessMean: 0.80, accessConc: 12, remoteMean: 0.7, symptMean: 0.40, symptConc: 15, careMean: 0.60, careConc: 12, xc: 0.5, yc: 0.45, spread: 0.20, attractBonus: 2000, color: "#e7298a" },
  hill_village: { label: "Hill Village", popMean: 1500, popCv: 0.35, emergMean: 80, emergCv: 0.35, accessMean: 0.30, accessConc: 8, remoteMean: 2.0, symptMean: 0.35, symptConc: 15, careMean: 0.40, careConc: 12, xc: 0.6, yc: 0.80, spread: 0.15, attractBonus: 0, color: "#66a61e" },
};

const ARCHETYPE_ORDER = ["swamp", "lakeside", "inland", "market_town", "hill_village"];

// ============================================================================
// LANDSCAPE GENERATOR (port of landscape_generator.py)
// ============================================================================

const BIONOMICS = {
  mu: 0.1, f: 1 / 3, q: 0.9, eip: 10, eggs: 30, b: 0.55, r: 1 / 200, c: 0.05,
  itn_rr: 0.56, itn_ss: 0.03, phi: 0.85, irs_wk: 0.60, irs_rr: 0.05,
  cure_rate: 0.85,
  // Immunity parameters (SIRS extension)
  alpha: 0.38,        // susceptibility reduction in immune individuals (0 = fully immune, 1 = no effect)
  omega: 1 / 540,     // immunity waning rate (~1.5 years without boosting)
  c_imm_factor: 0.3,  // infectiousness reduction for immune individuals who are reinfected
};

// Waning and campaign parameters
const WANING = {
  // Dual-AI ITN (e.g., Interceptor G2, Royal Guard)
  itn_halflife_days: 2.5 * 365,    // insecticidal half-life (~2.5 years)
  itn_retention_halflife: 4 * 365,  // physical retention half-life (~4 years, people discard)
  itn_campaign_default_years: 3,    // default campaign frequency

  // IRS (Actellic 300CS / pirimiphos-methyl)
  irs_halflife_days: 6 * 30,        // ~6 months residual
  irs_rounds_default: 1,            // default rounds per year
};

function generateLandscape(config) {
  const { seed, counts, importPrev, gravityExp, homeFrac, mapW, mapH, borderThresh, extTimeBase } = config;
  const rng = new PRNG(seed);

  // Build archetype list
  let archetypeList = [];
  for (const key of ARCHETYPE_ORDER) {
    for (let i = 0; i < (counts[key] || 0); i++) archetypeList.push(key);
  }
  // Shuffle
  for (let i = archetypeList.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1));
    [archetypeList[i], archetypeList[j]] = [archetypeList[j], archetypeList[i]];
  }

  const nInt = archetypeList.length;
  const nTotal = nInt + 1;

  // Place patches
  const positions = new Float64Array(nInt * 2);
  const placed = [];
  // Market towns first
  const order = [...Array(nInt).keys()].sort((a, b) => {
    const aM = archetypeList[a] === "market_town" ? 0 : 1;
    const bM = archetypeList[b] === "market_town" ? 0 : 1;
    return aM - bM;
  });

  for (const idx of order) {
    const arch = ARCHETYPES[archetypeList[idx]];
    let x, y, ok;
    for (let att = 0; att < 200; att++) {
      x = rng.normal(arch.xc * mapW, arch.spread * mapW);
      y = rng.normal(arch.yc * mapH, arch.spread * mapH);
      x = Math.max(0.3, Math.min(mapW - 0.3, x));
      y = Math.max(0.3, Math.min(mapH - 0.3, y));
      ok = true;
      for (const pi of placed) {
        const dx = x - positions[pi * 2], dy = y - positions[pi * 2 + 1];
        if (Math.sqrt(dx * dx + dy * dy) < 0.8) { ok = false; break; }
      }
      if (ok) break;
    }
    positions[idx * 2] = x;
    positions[idx * 2 + 1] = y;
    placed.push(idx);
  }

  // Distance matrix
  const dist = new Float64Array(nInt * nInt);
  for (let i = 0; i < nInt; i++) for (let j = i + 1; j < nInt; j++) {
    const dx = positions[i * 2] - positions[j * 2], dy = positions[i * 2 + 1] - positions[j * 2 + 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    dist[i * nInt + j] = d; dist[j * nInt + i] = d;
  }

  // Find market town indices
  const marketIdxs = [];
  for (let i = 0; i < nInt; i++) if (archetypeList[i] === "market_town") marketIdxs.push(i);

  // Generate patch params
  const patches = [];
  for (let i = 0; i < nInt; i++) {
    const ak = archetypeList[i];
    const arch = ARCHETYPES[ak];
    let pop = rng.lognormal(arch.popMean, arch.popCv);
    pop = Math.max(200, Math.round(pop / 50) * 50);
    let emerg = Math.max(20, rng.lognormal(arch.emergMean, arch.emergCv));
    let access = rng.betaMeanConc(arch.accessMean, arch.accessConc);
    let remote = Math.max(0.3, rng.lognormal(arch.remoteMean, 0.2));
    let sympt = rng.betaMeanConc(arch.symptMean, arch.symptConc);
    let care = rng.betaMeanConc(arch.careMean, arch.careConc);

    // Facility access adjustment by distance to market
    if (marketIdxs.length > 0 && ak !== "market_town") {
      let minDist = Infinity;
      for (const mi of marketIdxs) minDist = Math.min(minDist, dist[i * nInt + mi]);
      access = Math.max(0.05, access - Math.min(0.20, 0.04 * minDist));
      remote *= (1 + 0.05 * minDist);
    }

    const typeCount = patches.filter(p => p.archetype === ak).length;
    patches.push({
      name: `${arch.label} ${typeCount + 1}`, archetype: ak,
      population: pop, emergence: emerg, access, remote, sympt, care,
      x: positions[i * 2], y: positions[i * 2 + 1],
      color: arch.color,
    });
  }

  // External patch
  patches.push({
    name: "External Region", archetype: "external",
    population: 50000, emergence: 200, access: 0, remote: 1, sympt: 0.3, care: 0.5,
    x: mapW / 2, y: -1, color: "#999", isExternal: true, extPrev: importPrev,
  });

  // Movement matrix (gravity model) — flat row-major nTotal × nTotal
  const Theta = new Float64Array(nTotal * nTotal);
  const attract = new Float64Array(nInt);
  for (let i = 0; i < nInt; i++) {
    attract[i] = patches[i].population;
    if (archetypeList[i] === "market_town") attract[i] *= 1.5;
  }

  for (let j = 0; j < nInt; j++) {
    const raw = new Float64Array(nInt);
    let total = 0;
    for (let i = 0; i < nInt; i++) {
      if (i === j) continue;
      const d = Math.max(dist[i * nInt + j], 0.1);
      raw[i] = attract[i] / Math.pow(d, gravityExp);
      total += raw[i];
    }
    const maxAway = 1 - homeFrac;
    for (let i = 0; i < nInt; i++) {
      if (i === j) continue;
      Theta[i * nTotal + j] = total > 0 ? (raw[i] / total) * maxAway : 0;
    }
    Theta[j * nTotal + j] = 1 - (total > 0 ? maxAway : 0);
  }

  // External zone residents stay external
  const extIdx = nTotal - 1;
  Theta[extIdx * nTotal + extIdx] = 1.0;

  // Border patches spend time external
  const borderY = borderThresh * mapH;
  for (let j = 0; j < nInt; j++) {
    const yj = positions[j * 2 + 1];
    if (yj <= borderY) {
      const borderFrac = 1 - yj / borderY;
      let extTime = extTimeBase * Math.pow(borderFrac, 2.0);
      extTime = Math.min(extTime, 0.15);
      if (extTime > 0.005) {
        Theta[extIdx * nTotal + j] = extTime;
        Theta[j * nTotal + j] -= extTime;
        if (Theta[j * nTotal + j] < 0.5) Theta[j * nTotal + j] = 0.5;
      }
    }
  }

  // Normalize columns
  for (let j = 0; j < nTotal; j++) {
    let s = 0;
    for (let i = 0; i < nTotal; i++) s += Theta[i * nTotal + j];
    if (s > 0) for (let i = 0; i < nTotal; i++) Theta[i * nTotal + j] /= s;
  }

  // Mosquito dispersal
  const K = new Float64Array(nTotal * nTotal);
  const dispScale = 1.5;
  for (let j = 0; j < nInt; j++) {
    let total = 0;
    for (let i = 0; i < nInt; i++) {
      if (i === j) continue;
      let w = Math.exp(-dist[i * nInt + j] / dispScale);
      if (w < 0.01) w = 0;
      K[i * nTotal + j] = w;
      total += w;
    }
    if (total > 0) for (let i = 0; i < nInt; i++) K[i * nTotal + j] /= total;
  }

  // Mark border patches
  for (let i = 0; i < nInt; i++) {
    patches[i].isBorder = Theta[extIdx * nTotal + i] > 0.005;
  }

  return { patches, Theta, K, nInt, nTotal, dist, positions, archetypeList, config };
}

// ============================================================================
// ODE SOLVER (faithful port of simulator_fast.py)
// ============================================================================

function buildODE(landscape, interventions, strategyConfig) {
  const { patches, Theta, K, nInt, nTotal } = landscape;
  const n = nTotal;
  const ni = nInt;
  const bio = BIONOMICS;
  const CHW_ACCESS_EXT = 0.6;
  const CURE_CARE_BONUS = 0.5;
  const ACUTE_DAYS = 14;

  // Per-patch arrays (time-independent)
  const H = new Float64Array(n);
  const emergence = new Float64Array(n);
  const f0 = new Float64Array(n);
  const g0 = new Float64Array(n);
  const q = new Float64Array(n);
  const eip = new Float64Array(n);
  const b = new Float64Array(n);
  const r = new Float64Array(n);
  const c = new Float64Array(n);
  const cm = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const p = patches[i];
    H[i] = p.population;
    emergence[i] = p.emergence;
    f0[i] = bio.f; g0[i] = bio.mu; q[i] = bio.q; eip[i] = bio.eip;
    b[i] = bio.b; r[i] = bio.r; c[i] = bio.c;
  }

  // Per-patch intervention config (nominal coverage, CHW, cure)
  const itnCovNom = new Float64Array(n);   // nominal ITN coverage (at campaign time)
  const irsCovNom = new Float64Array(n);   // nominal IRS coverage (at spray time)
  const hasChw = new Uint8Array(n);
  const cureRate = new Float64Array(n);
  for (let i = 0; i < n; i++) cureRate[i] = bio.cure_rate;

  if (interventions) {
    for (const iv of interventions) {
      for (const pi of iv.patchIndices) {
        itnCovNom[pi] = Math.max(itnCovNom[pi], iv.itnCov || 0);
        irsCovNom[pi] = Math.max(irsCovNom[pi], iv.irsCov || 0);
        if (iv.chw) hasChw[pi] = 1;
        if (iv.improvedCure > 0) cureRate[pi] = Math.max(cureRate[pi], iv.improvedCure);
      }
    }
  }

  // Campaign timing config (strategy-level, shared across patches)
  const cfg = strategyConfig || {};
  const itnStartDay = (cfg.itnStartYear || 0) * 365;
  const itnCycleYears = cfg.itnCycleYears || WANING.itn_campaign_default_years;
  const itnCycleDays = itnCycleYears * 365;
  const itnHalflife = WANING.itn_halflife_days;
  const itnRetHalflife = WANING.itn_retention_halflife;
  const itnDecay = Math.log(2) / itnHalflife;
  const itnRetDecay = Math.log(2) / itnRetHalflife;

  const irsStartDay = (cfg.irsStartYear || 0) * 365;
  const irsRoundsPerYear = cfg.irsRoundsPerYear || WANING.irs_rounds_default;
  const irsCycleDays = 365 / irsRoundsPerYear;
  const irsHalflife = WANING.irs_halflife_days;
  const irsDecay = Math.log(2) / irsHalflife;

  // Function to compute effective ITN coverage at time t for a patch
  // After each campaign, efficacy decays exponentially; retention also decays
  function itnEffectiveAtTime(t, nomCov) {
    if (nomCov <= 0 || t < itnStartDay) return 0;
    const timeSinceStart = t - itnStartDay;
    // Time since most recent campaign
    const timeSinceCampaign = timeSinceStart % itnCycleDays;
    // Insecticidal efficacy decay
    const efficacy = Math.exp(-itnDecay * timeSinceCampaign);
    // Physical retention decay (people discarding nets)
    const retention = Math.exp(-itnRetDecay * timeSinceCampaign);
    return nomCov * efficacy * retention;
  }

  // Function to compute effective IRS coverage at time t
  function irsEffectiveAtTime(t, nomCov) {
    if (nomCov <= 0 || t < irsStartDay) return 0;
    const timeSinceStart = t - irsStartDay;
    const timeSinceSpray = timeSinceStart % irsCycleDays;
    const efficacy = Math.exp(-irsDecay * timeSinceSpray);
    return nomCov * efficacy;
  }

  // Case management rate (time-independent, computed once)
  for (let i = 0; i < ni; i++) {
    const p = patches[i];
    let effAccess = p.access;
    if (hasChw[i]) effAccess += CHW_ACCESS_EXT * (1 - p.access);
    effAccess = Math.min(effAccess, 1);
    const cureBonus = Math.max(0, cureRate[i] - 0.85) * CURE_CARE_BONUS;
    const careSeeking = Math.min(1, (p.care + cureBonus) * effAccess);
    const probTreated = p.sympt * careSeeking * cureRate[i];
    cm[i] = probTreated / ACUTE_DAYS;
  }

  // Host availability W = Theta @ H (time-independent)
  const W = matVecMul(Theta, H);

  // Incubation rates & effective recovery
  const incub = new Float64Array(n);
  const rEff = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    incub[i] = eip[i] > 0 ? 1 / eip[i] : 0;
    rEff[i] = r[i] + cm[i];
  }

  // External patch pre-computation (use baseline f0/g0 for external)
  const extM = new Float64Array(n), extY = new Float64Array(n);
  const extZ = new Float64Array(n), extI = new Float64Array(n);
  for (let i = ni; i < n; i++) {
    const prev = patches[i].extPrev || 0;
    extI[i] = prev * H[i];
    if (prev > 0 && prev < 1) {
      const eirEq = r[i] * prev / (b[i] * (1 - prev));
      extZ[i] = eirEq * H[i] / (f0[i] * q[i]);
      extM[i] = extZ[i] / 0.05;
      extY[i] = 0.15 * extM[i];
    }
  }

  // Pre-allocate working arrays for the RHS
  const Mall = new Float64Array(n), Yall = new Float64Array(n);
  const Zall = new Float64Array(n), Iall = new Float64Array(n);
  const Rall = new Float64Array(n);  // immune/semi-immune pool
  const f_eff = new Float64Array(n), g_eff = new Float64Array(n), sigma_arr = new Float64Array(n);

  // Immunity parameters
  const alpha = bio.alpha;         // susceptibility reduction in immune individuals
  const omega = bio.omega;         // immunity waning rate
  const c_imm_factor = bio.c_imm_factor; // infectiousness reduction for immune reinfections

  // External patch: estimate immune pool from prevalence
  // At high endemic equilibrium, roughly (1 - prev) * 0.5 of the population is immune
  const extR = new Float64Array(n);
  for (let i = ni; i < n; i++) {
    const prev = patches[i].extPrev || 0;
    // In a high-transmission area, many recovered people have immunity
    extR[i] = prev > 0 ? (1 - prev) * 0.6 * H[i] : 0;
  }

  // nStates is now 5 per internal patch
  const nStates = ni * 5;

  function rhs(t, state, derivs) {
    // Unpack external state
    for (let i = 0; i < n; i++) { Mall[i] = extM[i]; Yall[i] = extY[i]; Zall[i] = extZ[i]; Iall[i] = extI[i]; Rall[i] = extR[i]; }
    for (let idx = 0; idx < ni; idx++) {
      Mall[idx] = Math.max(state[idx * 5], 0);
      Yall[idx] = Math.max(state[idx * 5 + 1], 0);
      Zall[idx] = Math.max(state[idx * 5 + 2], 0);
      Iall[idx] = Math.max(state[idx * 5 + 3], 0);
      Rall[idx] = Math.max(state[idx * 5 + 4], 0);
    }

    // Compute time-varying effective bionomic params per patch
    for (let i = 0; i < n; i++) {
      const cI = itnEffectiveAtTime(t, itnCovNom[i]);
      const cR = irsEffectiveAtTime(t, irsCovNom[i]);
      const rr = bio.itn_rr, ss = bio.itn_ss, dd = 1 - rr - ss;
      const phi = bio.phi;
      const wk = bio.irs_wk;
      const pFeed = (1 - cI) + cI * (phi * ss + (1 - phi));
      const pKillItn = cI * phi * dd;
      const pKillIrs = pFeed * cR * wk;
      f_eff[i] = f0[i] * pFeed;
      g_eff[i] = g0[i] + f0[i] * (pKillItn + pKillIrs);
      sigma_arr[i] = 0.5 * g_eff[i];
    }

    // Kappa: net infectiousness of humans in each patch
    // Infected individuals from the immune pool are less infectious (c_imm_factor)
    // Approximate: effective_c = c * (1 - immune_fraction_of_infected * (1 - c_imm_factor))
    // Since we don't track I_naive vs I_immune separately, use R/(R+S) as proxy for
    // what fraction of new infections come from immune individuals
    const cI_arr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const Hi = H[i];
      const Ri = Rall[i];
      const Si = Math.max(Hi - Iall[i] - Ri, 0);
      // Fraction of current infected pool that came from immune reinfections
      const immuneFrac = (Si + Ri) > 0 ? (alpha * Ri) / (Si + alpha * Ri) : 0;
      const effectiveC = c[i] * (1 - immuneFrac * (1 - c_imm_factor));
      cI_arr[i] = effectiveC * Iall[i];
    }
    const kappa = matVecMul(Theta, cI_arr);
    for (let i = 0; i < n; i++) kappa[i] = W[i] > 0 ? kappa[i] / W[i] : 0;

    // EIR = f_eff * q * Z / W
    const EIR = new Float64Array(n);
    for (let i = 0; i < n; i++) EIR[i] = W[i] > 0 ? f_eff[i] * q[i] * Zall[i] / W[i] : 0;

    // FOI = b * (Theta^T @ EIR)
    const FOI = matTVecMul(Theta, EIR);
    for (let i = 0; i < n; i++) FOI[i] *= b[i];

    // Dispersal immigration
    const sigM = new Float64Array(n), sigY = new Float64Array(n), sigZ = new Float64Array(n);
    for (let i = 0; i < n; i++) { sigM[i] = sigma_arr[i] * Mall[i]; sigY[i] = sigma_arr[i] * Yall[i]; sigZ[i] = sigma_arr[i] * Zall[i]; }
    const immM = matVecMul(K, sigM), immY = matVecMul(K, sigY), immZ = matVecMul(K, sigZ);

    // Derivatives for internal patches (SIRS model)
    for (let idx = 0; idx < ni; idx++) {
      const Mi = Mall[idx], Yi = Yall[idx], Zi = Zall[idx], Ii = Iall[idx], Ri = Rall[idx];
      const Hi = H[idx];
      const Si = Math.max(Hi - Ii - Ri, 0);  // Susceptible = total - infected - immune

      // Mosquito dynamics (unchanged)
      const susceptMosq = Math.max(Mi - Yi - Zi, 0);
      const newInf = f_eff[idx] * q[idx] * kappa[idx] * susceptMosq;
      const becomeInf = incub[idx] * Yi;

      derivs[idx * 5] = emergence[idx] + immM[idx] - g_eff[idx] * Mi - sigma_arr[idx] * Mi;
      derivs[idx * 5 + 1] = newInf + immY[idx] - g_eff[idx] * Yi - sigma_arr[idx] * Yi - becomeInf;
      derivs[idx * 5 + 2] = becomeInf + immZ[idx] - g_eff[idx] * Zi - sigma_arr[idx] * Zi;

      // Human SIRS dynamics
      const foi = FOI[idx];
      const newInfFromS = foi * Si;                // fully susceptible → infected
      const newInfFromR = foi * alpha * Ri;        // immune reinfection (reduced rate)
      const recovery = rEff[idx] * Ii;             // infected → immune
      const immuneWaning = omega * Ri;             // immune → susceptible

      derivs[idx * 5 + 3] = newInfFromS + newInfFromR - recovery;     // dI/dt
      derivs[idx * 5 + 4] = recovery - immuneWaning - newInfFromR;    // dR/dt
    }
  }

  return { rhs, ni, nStates, H: H.slice(0, ni), emergence: emergence.slice(0, ni), g0: g0.slice(0, ni) };
}

// RK45 adaptive step (Dormand-Prince)
function solveODE(rhsFn, y0, tEnd, dt = 2.0) {
  const n = y0.length;
  let y = new Float64Array(y0);
  let t = 0;
  const snapshots = [];
  let nextSnap = 0;
  const snapDt = Math.max(5, tEnd / 200);
  const k1 = new Float64Array(n), k2 = new Float64Array(n), k3 = new Float64Array(n);
  const k4 = new Float64Array(n), tmp = new Float64Array(n), derivs = new Float64Array(n);

  // Classic RK4 with fixed step — RHS is time-aware: rhs(t, state, derivs)
  while (t < tEnd) {
    const h = Math.min(dt, tEnd - t);

    // k1
    rhsFn(t, y, k1);
    // k2
    for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * h * k1[i];
    rhsFn(t + 0.5 * h, tmp, k2);
    // k3
    for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * h * k2[i];
    rhsFn(t + 0.5 * h, tmp, k3);
    // k4
    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * k3[i];
    rhsFn(t + h, tmp, k4);
    // Update
    for (let i = 0; i < n; i++) {
      y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      if (y[i] < 0) y[i] = 0; // clamp
    }
    t += h;

    if (t >= nextSnap) {
      snapshots.push({ t, state: new Float64Array(y) });
      nextSnap += snapDt;
    }
  }
  // Ensure final state is captured
  if (snapshots.length === 0 || snapshots[snapshots.length - 1].t < t - 0.1) {
    snapshots.push({ t, state: new Float64Array(y) });
  }
  return snapshots;
}

function runSimulation(landscape, interventions, tMaxDays, initPrevByPatch, strategyConfig) {
  const ode = buildODE(landscape, interventions, strategyConfig);
  const ni = ode.ni;
  const nStates = ode.nStates;  // ni * 5 now

  // Initial conditions: per-patch prevalence with SIRS immune pool
  const y0 = new Float64Array(nStates);
  for (let idx = 0; idx < ni; idx++) {
    const M0 = ode.emergence[idx] / ode.g0[idx];
    const prev0 = (initPrevByPatch && initPrevByPatch[idx] != null) ? initPrevByPatch[idx] : 0.4;
    // In an endemic equilibrium, a substantial fraction of non-infected people are immune
    // Estimate: R0 ≈ (1 - prev0) * 0.5 * H (half of uninfected are semi-immune)
    const R0 = (1 - prev0) * 0.5 * ode.H[idx];
    y0[idx * 5] = M0;
    y0[idx * 5 + 1] = 0.15 * M0;
    y0[idx * 5 + 2] = 0.05 * M0;
    y0[idx * 5 + 3] = prev0 * ode.H[idx];
    y0[idx * 5 + 4] = R0;
  }

  const snapshots = solveODE(ode.rhs, y0, tMaxDays, 2.0);

  // Parse results
  const times = snapshots.map(s => s.t / 365);
  const prevByPatch = [];
  for (let idx = 0; idx < ni; idx++) {
    prevByPatch.push(snapshots.map(s => Math.max(0, Math.min(1, s.state[idx * 5 + 3] / ode.H[idx]))));
  }
  // Zone average (pop-weighted)
  const totalPop = ode.H.reduce((a, b) => a + b, 0);
  const zoneAvg = snapshots.map((s, ti) => {
    let sum = 0;
    for (let idx = 0; idx < ni; idx++) sum += prevByPatch[idx][ti] * ode.H[idx];
    return sum / totalPop;
  });

  return { times, prevByPatch, zoneAvg, H: ode.H, ni };
}

// ============================================================================
// COSTING (simplified)
// ============================================================================

const COSTS = {
  itnPerPersonYear: 0.8,   // net cost + delivery, annualized (net=$2.50/1.8ppl/3yr + $1 delivery)
  irsPerPersonYear: 2.8,   // per covered person per year ($3.50/structure/5ppl * 2 rounds)
  chwPerPersonYear: 4.0,   // salary + training + supplies, annualized, per person served
  curePerPersonYear: 1.5,  // supply chain + training + QA, annualized, per person
  overheadFrac: 0.15,
};

function computeCosts(landscape, interventions) {
  const ni = landscape.nInt;
  const patchCosts = [];
  let total = 0;

  const itnCov = new Float64Array(ni);
  const irsCov = new Float64Array(ni);
  const hasChw = new Uint8Array(ni);
  const hasCure = new Uint8Array(ni);

  if (interventions) {
    for (const iv of interventions) {
      for (const pi of iv.patchIndices) {
        if (pi < ni) {
          itnCov[pi] = Math.max(itnCov[pi], iv.itnCov || 0);
          irsCov[pi] = Math.max(irsCov[pi], iv.irsCov || 0);
          if (iv.chw) hasChw[pi] = 1;
          if (iv.improvedCure > 0) hasCure[pi] = 1;
        }
      }
    }
  }

  for (let i = 0; i < ni; i++) {
    const pop = landscape.patches[i].population;
    const remote = landscape.patches[i].remote;
    const itn = itnCov[i] * pop * COSTS.itnPerPersonYear * remote;
    const irs = irsCov[i] * pop * COSTS.irsPerPersonYear * remote;
    const chw = hasChw[i] ? pop * COSTS.chwPerPersonYear / 500 * Math.ceil(pop / 500) / (pop / 500) : 0;
    // Simpler: just per-pop
    const chwCost = hasChw[i] ? Math.ceil(pop / 500) * (1200 + 300 + 500 / 3) : 0;
    const cureCost = hasCure[i] ? Math.ceil(pop / 3000) * (2000 + 1500 / 3 + 800) : 0;
    const direct = itn + irs + chwCost + cureCost;
    const overhead = direct * COSTS.overheadFrac;
    const t = direct + overhead;
    patchCosts.push({ itn, irs, chw: chwCost, cure: cureCost, overhead, total: t });
    total += t;
  }

  return {
    patchCosts, total,
    breakdown: {
      itn: patchCosts.reduce((s, p) => s + p.itn, 0),
      irs: patchCosts.reduce((s, p) => s + p.irs, 0),
      chw: patchCosts.reduce((s, p) => s + p.chw, 0),
      cure: patchCosts.reduce((s, p) => s + p.cure, 0),
      overhead: patchCosts.reduce((s, p) => s + p.overhead, 0),
    },
  };
}

// ============================================================================
// STRATEGY TEMPLATES
// ============================================================================

function makeTemplateInterventions(templateKey, landscape) {
  const ni = landscape.nInt;
  const allInternal = [...Array(ni).keys()];

  // Find high-transmission patches (top half by M/P ratio)
  const ratios = allInternal.map(i => ({
    i, ratio: (landscape.patches[i].emergence / BIONOMICS.mu) / landscape.patches[i].population,
  }));
  ratios.sort((a, b) => b.ratio - a.ratio);
  const highTx = ratios.slice(0, Math.ceil(ni / 2)).map(r => r.i);

  // Low-access patches
  const lowAccess = allInternal.filter(i => landscape.patches[i].access < 0.5);

  switch (templateKey) {
    case "none": return [];
    case "itn_universal":
      return [{ patchIndices: allInternal, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0 }];
    case "itn_targeted":
      return [{ patchIndices: highTx, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0 }];
    case "irs_universal":
      return [{ patchIndices: allInternal, itnCov: 0, irsCov: 0.8, chw: false, improvedCure: 0 }];
    case "irs_targeted":
      return [{ patchIndices: highTx, itnCov: 0, irsCov: 0.8, chw: false, improvedCure: 0 }];
    case "itn_irs_combo":
      return [
        { patchIndices: allInternal, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0 },
        { patchIndices: highTx, itnCov: 0, irsCov: 0.8, chw: false, improvedCure: 0 },
      ];
    case "chw_only":
      return [{ patchIndices: lowAccess, itnCov: 0, irsCov: 0, chw: true, improvedCure: 0 }];
    case "chw_cure":
      return [
        { patchIndices: lowAccess, itnCov: 0, irsCov: 0, chw: true, improvedCure: 0 },
        { patchIndices: allInternal, itnCov: 0, irsCov: 0, chw: false, improvedCure: 0.95 },
      ];
    case "itn_chw":
      return [
        { patchIndices: allInternal, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0 },
        { patchIndices: lowAccess, itnCov: 0, irsCov: 0, chw: true, improvedCure: 0 },
      ];
    case "itn_cure":
      return [
        { patchIndices: allInternal, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0.95 },
      ];
    case "full_package":
      return [
        { patchIndices: allInternal, itnCov: 0.8, irsCov: 0, chw: false, improvedCure: 0.95 },
        { patchIndices: lowAccess, itnCov: 0, irsCov: 0, chw: true, improvedCure: 0 },
        { patchIndices: highTx, itnCov: 0, irsCov: 0.8, chw: false, improvedCure: 0 },
      ];
    default: return [];
  }
}

// Merge intervention layers into per-patch summary
function mergeInterventions(interventions, ni) {
  const perPatch = [];
  for (let i = 0; i < ni; i++) perPatch.push({ itnCov: 0, irsCov: 0, chw: false, improvedCure: 0 });
  for (const iv of interventions) {
    for (const pi of iv.patchIndices) {
      if (pi < ni) {
        perPatch[pi].itnCov = Math.max(perPatch[pi].itnCov, iv.itnCov || 0);
        perPatch[pi].irsCov = Math.max(perPatch[pi].irsCov, iv.irsCov || 0);
        if (iv.chw) perPatch[pi].chw = true;
        if (iv.improvedCure > 0) perPatch[pi].improvedCure = Math.max(perPatch[pi].improvedCure, iv.improvedCure);
      }
    }
  }
  return perPatch;
}

// Convert per-patch overrides back to intervention list
function perPatchToInterventions(perPatch) {
  const interventions = [];
  for (let i = 0; i < perPatch.length; i++) {
    const pp = perPatch[i];
    if (pp.itnCov > 0 || pp.irsCov > 0 || pp.chw || pp.improvedCure > 0) {
      interventions.push({
        patchIndices: [i], itnCov: pp.itnCov, irsCov: pp.irsCov,
        chw: pp.chw, improvedCure: pp.improvedCure,
      });
    }
  }
  return interventions;
}

// ============================================================================
// TEMPLATE LABELS
// ============================================================================

const TEMPLATES = [
  { key: "none", label: "No intervention", group: "Baseline" },
  { key: "itn_universal", label: "Universal ITN (80%)", group: "Vector Control" },
  { key: "itn_targeted", label: "Targeted ITN (high-Tx patches)", group: "Vector Control" },
  { key: "irs_universal", label: "Universal IRS (80%)", group: "Vector Control" },
  { key: "irs_targeted", label: "Targeted IRS (high-Tx patches)", group: "Vector Control" },
  { key: "itn_irs_combo", label: "ITN everywhere + IRS (high-Tx)", group: "Vector Control" },
  { key: "chw_only", label: "CHWs only (low-access patches)", group: "Case Management" },
  { key: "chw_cure", label: "CHWs + improved cure rate", group: "Case Management" },
  { key: "itn_chw", label: "ITN + CHWs (low-access patches)", group: "Combined" },
  { key: "itn_cure", label: "ITN + improved cure rate", group: "Combined" },
  { key: "full_package", label: "Full package (ITN+IRS+CHW+Cure)", group: "Combined" },
];

// ============================================================================
// INITIAL PREVALENCE DISTRIBUTION
// ============================================================================

function distributePrevalence(landscape, targetZoneAvg) {
  // Distribute a target zone-average prevalence across patches proportionally
  // to each patch's transmission intensity (M/P ratio). This produces realistic
  // heterogeneity: swamp patches start high, hill villages start low.
  //
  // Method: weight_i = (M/P)_i ^ 0.6  (sublinear to avoid extremes)
  // Then scale so pop-weighted average = targetZoneAvg, clamped to [0.01, 0.90].
  const ni = landscape.nInt;
  const patches = landscape.patches;
  const mu = BIONOMICS.mu;

  const weights = [];
  let totalPop = 0;
  for (let i = 0; i < ni; i++) {
    const mp = (patches[i].emergence / mu) / patches[i].population;
    weights.push(Math.pow(Math.max(mp, 0.1), 0.6));
    totalPop += patches[i].population;
  }

  // Compute weighted average of weights (pop-weighted)
  let weightedAvg = 0;
  for (let i = 0; i < ni; i++) weightedAvg += weights[i] * patches[i].population;
  weightedAvg /= totalPop;

  // Scale factor: each patch gets prev_i = targetZoneAvg * (weight_i / weightedAvg)
  const prevs = [];
  for (let i = 0; i < ni; i++) {
    let p = targetZoneAvg * (weights[i] / weightedAvg);
    p = Math.max(0.01, Math.min(0.90, p));
    prevs.push(Math.round(p * 1000) / 1000); // round to 0.1%
  }

  return prevs;
}

// ============================================================================
// STRATEGY COLORS
// ============================================================================

const STRATEGY_COLORS = ["#e6194b", "#3cb44b", "#4363d8"];
const STRATEGY_NAMES = ["Strategy A", "Strategy B", "Strategy C"];

// ============================================================================
// UI COMPONENTS
// ============================================================================

function prevColorScale(prev) {
  // Green (low) → Yellow → Orange → Red (high) prevalence color scale
  // Input: prevalence 0-1, Output: hex color string
  const v = Math.max(0, Math.min(1, prev));
  // 0% → #2d8a4e (green), 20% → #a8c044, 40% → #f0c808 (yellow), 60% → #e8781a, 80%+ → #c22a2a (red)
  const stops = [
    [0.00, [45, 138, 78]],
    [0.15, [120, 180, 60]],
    [0.30, [200, 200, 40]],
    [0.45, [240, 180, 20]],
    [0.60, [232, 120, 26]],
    [0.80, [194, 42, 42]],
    [1.00, [140, 20, 20]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let s = 0; s < stops.length - 1; s++) {
    if (v >= stops[s][0] && v <= stops[s + 1][0]) { lo = stops[s]; hi = stops[s + 1]; break; }
  }
  const t = hi[0] === lo[0] ? 0 : (v - lo[0]) / (hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + t * (hi[1][0] - lo[1][0]));
  const g = Math.round(lo[1][1] + t * (hi[1][1] - lo[1][1]));
  const b = Math.round(lo[1][2] + t * (hi[1][2] - lo[1][2]));
  return `rgb(${r},${g},${b})`;
}

function LandscapeMap({ landscape, selectedPatch, onSelectPatch, strategyPerPatch,
  prevalenceValues, colorMode = "archetype", title, width = 380, height = 320, compact = false }) {
  if (!landscape) return null;
  const { patches, nInt, config: cfg } = landscape;
  const mapW = cfg.mapW, mapH = cfg.mapH;
  const scaleX = (width - 40) / mapW;
  const scaleY = (height - (compact ? 35 : 50)) / mapH;
  const scale = Math.min(scaleX, scaleY);
  const ox = 20, oy = height - (compact ? 15 : 25);

  const maxPop = Math.max(...patches.slice(0, nInt).map(p => p.population));
  const usePrevColor = colorMode === "prevalence" && prevalenceValues;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {/* Title */}
      {title && <text x={width / 2} y={14} textAnchor="middle" fill="var(--text, #e8e6e3)" fontSize={11} fontWeight={700}>{title}</text>}
      {/* Border zone */}
      <rect x={ox} y={oy - cfg.borderThresh * mapH * scale} width={mapW * scale}
        height={cfg.borderThresh * mapH * scale}
        fill="var(--border-zone, #f5e6d3)" opacity={0.3} rx={3} />
      {!compact && <text x={ox + mapW * scale / 2} y={oy - 4} textAnchor="middle"
        fill="var(--text-dim, #999)" fontSize={9} fontStyle="italic">External border zone</text>}
      {/* Patches */}
      {patches.slice(0, nInt).map((p, i) => {
        const cx = ox + p.x * scale;
        const cy = oy - p.y * scale;
        const r = compact ? (4 + 10 * Math.sqrt(p.population / maxPop)) : (6 + 14 * Math.sqrt(p.population / maxPop));
        const isSelected = selectedPatch === i;
        const spp = strategyPerPatch ? strategyPerPatch[i] : null;
        const hasIntervention = spp && (spp.itnCov > 0 || spp.irsCov > 0 || spp.chw || spp.improvedCure > 0);

        let fillColor = p.color;
        if (usePrevColor) {
          fillColor = prevColorScale(prevalenceValues[i]);
        }

        return (
          <g key={i} onClick={() => onSelectPatch && onSelectPatch(i)} style={{ cursor: onSelectPatch ? "pointer" : "default" }}>
            {hasIntervention && !compact && <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="#000" strokeWidth={2} strokeDasharray="3,2" />}
            <circle cx={cx} cy={cy} r={r} fill={fillColor}
              stroke={isSelected ? "#000" : p.isBorder ? "#555" : "#fff"}
              strokeWidth={isSelected ? 3 : p.isBorder ? 2 : 1}
              opacity={hasIntervention === false && strategyPerPatch && !usePrevColor ? 0.35 : 0.85} />
            {/* Prevalence label on patch */}
            {usePrevColor && <text x={cx} y={cy + 3} textAnchor="middle" fontSize={compact ? 6.5 : 8}
              fill="#fff" fontWeight={700} style={{ pointerEvents: "none", textShadow: "0 0 3px rgba(0,0,0,0.8)" }}>
              {(prevalenceValues[i] * 100).toFixed(0)}%
            </text>}
            {!compact && <text x={cx} y={cy + r + 11} textAnchor="middle" fontSize={7.5}
              fill="var(--text-main, #333)" fontWeight={isSelected ? 700 : 400}>
              {p.name.replace("Settlement ", "S").replace("Village ", "V").replace("Town ", "T")}
            </text>}
          </g>
        );
      })}
      {/* Color scale legend for prevalence mode */}
      {usePrevColor && (
        <g>
          {[0, 0.2, 0.4, 0.6, 0.8].map((v, i) => (
            <g key={v}>
              <rect x={ox + i * 28} y={compact ? height - 12 : 4} width={28} height={8} fill={prevColorScale(v)} rx={1} />
              <text x={ox + i * 28 + 14} y={compact ? height - 1 : 20} textAnchor="middle"
                fontSize={7} fill="var(--text-dim, #999)">{(v * 100).toFixed(0)}%</text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

function PatchEditor({ patch, patchIdx, perPatch, onChange }) {
  if (!patch || !perPatch) return null;
  const pp = perPatch[patchIdx];
  const mp = (patch.emergence / BIONOMICS.mu) / patch.population;

  const set = (field, val) => {
    const next = perPatch.map((p, i) => i === patchIdx ? { ...p, [field]: val } : p);
    onChange(next);
  };

  return (
    <div style={{ padding: "10px 0", fontSize: 13 }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: patch.color }}>{patch.name}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px", fontSize: 12, color: "var(--text-dim, #888)", marginBottom: 10 }}>
        <span>Pop: {patch.population.toLocaleString()}</span>
        <span>M/P: {mp.toFixed(1)}</span>
        <span>Access: {(patch.access * 100).toFixed(0)}%</span>
        <span>Remote: {patch.remote.toFixed(1)}×</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ width: 70 }}>ITN cov.</span>
          <input type="range" min={0} max={100} step={5} value={pp.itnCov * 100}
            onChange={e => set("itnCov", +e.target.value / 100)}
            style={{ flex: 1 }} />
          <span style={{ width: 36, textAlign: "right" }}>{(pp.itnCov * 100).toFixed(0)}%</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ width: 70 }}>IRS cov.</span>
          <input type="range" min={0} max={100} step={5} value={pp.irsCov * 100}
            onChange={e => set("irsCov", +e.target.value / 100)}
            style={{ flex: 1 }} />
          <span style={{ width: 36, textAlign: "right" }}>{(pp.irsCov * 100).toFixed(0)}%</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={pp.chw} onChange={e => set("chw", e.target.checked)} />
          <span>Deploy CHWs</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={pp.improvedCure > 0}
            onChange={e => set("improvedCure", e.target.checked ? 0.95 : 0)} />
          <span>Improved cure rate (95%)</span>
        </label>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN APP
// ============================================================================

export default function MalariaSimulator() {
  // Landscape config
  const [seed, setSeed] = useState(42);
  const [counts, setCounts] = useState({ swamp: 3, lakeside: 4, inland: 5, market_town: 2, hill_village: 3 });
  const [importPrev, setImportPrev] = useState(0.45);
  const [tMaxYears, setTMaxYears] = useState(5);
  const [targetPrev, setTargetPrev] = useState(0.35);

  // Landscape
  const [landscape, setLandscape] = useState(null);

  // Per-patch initial prevalence (set when landscape is generated, editable)
  const [initPrevByPatch, setInitPrevByPatch] = useState(null);

  // Strategies (up to 3)
  const [strategies, setStrategies] = useState([
    { template: "none", perPatch: null, label: "Baseline", config: { itnStartYear: 0, itnCycleYears: 3, irsStartYear: 0, irsRoundsPerYear: 1 } },
    { template: "itn_universal", perPatch: null, label: "Universal ITN", config: { itnStartYear: 0, itnCycleYears: 3, irsStartYear: 0, irsRoundsPerYear: 1 } },
  ]);

  // Results
  const [results, setResults] = useState(null);
  const [simRunning, setSimRunning] = useState(false);

  // UI state
  const [activeStrategy, setActiveStrategy] = useState(1);
  const [selectedPatch, setSelectedPatch] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeTab, setActiveTab] = useState("landscape"); // landscape | strategies | results
  const [showAddModal, setShowAddModal] = useState(false);
  const [mapColorMode, setMapColorMode] = useState("archetype"); // "archetype" | "prevalence"

  const totalPatches = Object.values(counts).reduce((a, b) => a + b, 0);

  // Generate landscape
  const handleGenerate = useCallback(() => {
    const cfg = { seed, counts, importPrev, gravityExp: 2.0, homeFrac: 0.85, mapW: 10, mapH: 10, borderThresh: 0.35, extTimeBase: 0.08 };
    const ls = generateLandscape(cfg);
    setLandscape(ls);
    setResults(null);
    setSelectedPatch(null);

    // Distribute starting prevalence across patches by M/P ratio
    const initPrev = distributePrevalence(ls, targetPrev);
    setInitPrevByPatch(initPrev);

    // Reset strategy per-patch overrides
    setStrategies(prev => prev.map(s => {
      const ivs = makeTemplateInterventions(s.template, ls);
      return { ...s, perPatch: mergeInterventions(ivs, ls.nInt), config: s.config || { itnStartYear: 0, itnCycleYears: 3, irsStartYear: 0, irsRoundsPerYear: 1 } };
    }));
    setActiveTab("strategies");
  }, [seed, counts, importPrev, targetPrev]);

  // Update strategy template
  const setTemplate = useCallback((idx, templateKey) => {
    if (!landscape) return;
    setStrategies(prev => {
      const next = [...prev];
      const ivs = makeTemplateInterventions(templateKey, landscape);
      const label = TEMPLATES.find(t => t.key === templateKey)?.label || templateKey;
      next[idx] = { ...next[idx], template: templateKey, perPatch: mergeInterventions(ivs, landscape.nInt), label };
      return next;
    });
    setResults(null);
  }, [landscape]);

  const setPerPatch = useCallback((idx, pp) => {
    setStrategies(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], perPatch: pp, template: "custom" };
      return next;
    });
    setResults(null);
  }, []);

  // Add/remove/rename strategy
  const addStrategy = (templateKey) => {
    if (strategies.length >= 3 || !landscape) return;
    const tmpl = TEMPLATES.find(t => t.key === templateKey) || TEMPLATES[0];
    const ivs = makeTemplateInterventions(templateKey, landscape);
    setStrategies(prev => [...prev, {
      template: templateKey, perPatch: mergeInterventions(ivs, landscape.nInt), label: tmpl.label,
      config: { itnStartYear: 0, itnCycleYears: 3, irsStartYear: 0, irsRoundsPerYear: 1 },
    }]);
    setActiveStrategy(strategies.length);
    setShowAddModal(false);
    setResults(null);
  };
  const removeStrategy = (idx) => {
    if (strategies.length <= 1) return;
    setStrategies(prev => prev.filter((_, i) => i !== idx));
    if (activeStrategy >= strategies.length - 1) setActiveStrategy(Math.max(0, strategies.length - 2));
    setResults(null);
  };
  const renameStrategy = (idx, newLabel) => {
    setStrategies(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], label: newLabel };
      return next;
    });
  };

  // Run simulation
  const handleRun = useCallback(() => {
    if (!landscape) return;
    setSimRunning(true);
    setActiveTab("results");

    // Use setTimeout to allow UI to update
    setTimeout(() => {
      const tMax = tMaxYears * 365;
      const allResults = strategies.map(s => {
        const ivs = perPatchToInterventions(s.perPatch || []);
        const simRes = runSimulation(landscape, ivs, tMax, initPrevByPatch, s.config);
        const costs = computeCosts(landscape, ivs);
        return { ...simRes, costs, label: s.label };
      });
      setResults(allResults);
      setSimRunning(false);
    }, 50);
  }, [landscape, strategies, tMaxYears, initPrevByPatch]);

  // Count label
  const setCount = (key, val) => {
    const v = Math.max(0, Math.min(10, val));
    const newCounts = { ...counts, [key]: v };
    const newTotal = Object.values(newCounts).reduce((a, b) => a + b, 0);
    if (newTotal <= 30 && newTotal >= 1) setCounts(newCounts);
  };

  const currentStratPerPatch = strategies[activeStrategy]?.perPatch;

  // Update a single patch property in the landscape and recompute derived state
  const updatePatch = useCallback((patchIdx, field, value) => {
    if (!landscape) return;
    setLandscape(prev => {
      // Deep-clone enough to be safe
      const newPatches = prev.patches.map((p, i) => i === patchIdx ? { ...p } : p);
      const newLandscape = { ...prev, patches: newPatches, Theta: new Float64Array(prev.Theta), K: new Float64Array(prev.K) };

      if (field === "population") {
        newLandscape.patches[patchIdx].population = Math.max(50, Math.round(value / 50) * 50);
      } else if (field === "emergence") {
        newLandscape.patches[patchIdx].emergence = Math.max(5, value);
      } else if (field === "access") {
        newLandscape.patches[patchIdx].access = Math.max(0, Math.min(1, value));
      } else if (field === "isBorder") {
        const p = newLandscape.patches[patchIdx];
        const nT = newLandscape.nTotal;
        const extIdx = nT - 1;
        if (value && !p.isBorder) {
          // Make border: add 8% external time
          const extTime = 0.08;
          newLandscape.Theta[extIdx * nT + patchIdx] = extTime;
          newLandscape.Theta[patchIdx * nT + patchIdx] = Math.max(0.5, newLandscape.Theta[patchIdx * nT + patchIdx] - extTime);
        } else if (!value && p.isBorder) {
          // Remove border: return external time to home
          const oldExt = newLandscape.Theta[extIdx * nT + patchIdx];
          newLandscape.Theta[patchIdx * nT + patchIdx] += oldExt;
          newLandscape.Theta[extIdx * nT + patchIdx] = 0;
        }
        // Re-normalize column
        let s = 0;
        for (let i = 0; i < nT; i++) s += newLandscape.Theta[i * nT + patchIdx];
        if (s > 0) for (let i = 0; i < nT; i++) newLandscape.Theta[i * nT + patchIdx] /= s;
        newLandscape.patches[patchIdx].isBorder = value;
      }
      return newLandscape;
    });
    setResults(null);
  }, [landscape]);

  return (
    <div style={{
      fontFamily: "'Source Sans 3', 'Source Sans Pro', 'Segoe UI', system-ui, sans-serif",
      background: "var(--bg, #0f1117)",
      color: "var(--text, #e8e6e3)",
      minHeight: "100vh", padding: 0, margin: 0,
      "--bg": "#0f1117", "--bg2": "#1a1d27", "--bg3": "#252833",
      "--border": "#2e3140", "--text": "#e8e6e3", "--text-main": "#e8e6e3",
      "--text-dim": "#8b8d97", "--accent": "#4fc3f7", "--accent2": "#81c784",
      "--danger": "#ef5350", "--border-zone": "#3d3022",
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #1a1d27 0%, #0f1117 100%)",
        borderBottom: "1px solid var(--border)",
        padding: "16px 24px", display: "flex", alignItems: "center", gap: 16,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>
            <span style={{ color: "var(--accent)" }}>Spatial</span> Malaria Simulator
          </h1>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            Ross-Macdonald ODE · Multi-patch · ITN + IRS + CHW + Case Management
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 2, background: "var(--bg3)", borderRadius: 8, padding: 2 }}>
          {["landscape", "strategies", "results", "about"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              disabled={(tab === "strategies" || tab === "results") && !landscape}
              style={{
                padding: "7px 16px", fontSize: 12, fontWeight: 600, borderRadius: 6,
                border: "none", cursor: ((tab === "strategies" || tab === "results") && !landscape) ? "not-allowed" : "pointer",
                background: activeTab === tab ? "var(--accent)" : "transparent",
                color: activeTab === tab ? "#000" : "var(--text-dim)",
                opacity: ((tab === "strategies" || tab === "results") && !landscape) ? 0.4 : 1,
                transition: "all 0.15s",
              }}>
              {tab === "landscape" ? "1. Landscape" : tab === "strategies" ? "2. Strategies" : tab === "results" ? "3. Results" : "About"}
            </button>
          ))}
        </div>
      </div>

      {/* LANDSCAPE TAB */}
      {activeTab === "landscape" && (
        <div style={{ padding: "20px 24px", maxWidth: 900, margin: "0 auto" }}>
          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
            <h2 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Generate Landscape</h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px" }}>
              <label style={{ fontSize: 12 }}>
                <span style={{ color: "var(--text-dim)" }}>Random seed</span>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input type="number" value={seed} onChange={e => setSeed(+e.target.value)}
                    style={{ flex: 1, padding: "6px 10px", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13 }} />
                  <button onClick={() => setSeed(Math.floor(Math.random() * 10000))}
                    style={{ padding: "6px 12px", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
                    🎲
                  </button>
                </div>
              </label>
              <label style={{ fontSize: 12 }}>
                <span style={{ color: "var(--text-dim)" }}>Surrounding region prevalence</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <input type="range" min={0} max={80} step={5} value={importPrev * 100}
                    onChange={e => setImportPrev(+e.target.value / 100)} style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, width: 36, textAlign: "right" }}>{(importPrev * 100).toFixed(0)}%</span>
                </div>
              </label>
              <label style={{ fontSize: 12 }}>
                <span style={{ color: "var(--text-dim)" }}>Starting prevalence (zone average)</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <input type="range" min={5} max={70} step={5} value={targetPrev * 100}
                    onChange={e => setTargetPrev(+e.target.value / 100)} style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, width: 36, textAlign: "right" }}>{(targetPrev * 100).toFixed(0)}%</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  Distributed across patches by transmission intensity
                </div>
              </label>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
                Patch composition <span style={{ fontSize: 11 }}>({totalPatches} patches, max 30)</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ARCHETYPE_ORDER.map(key => (
                  <div key={key} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: "var(--bg3)", padding: "4px 10px", borderRadius: 6,
                    border: `1px solid ${ARCHETYPES[key].color}33`,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: ARCHETYPES[key].color }} />
                    <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 65 }}>
                      {key.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}
                    </span>
                    <button onClick={() => setCount(key, counts[key] - 1)}
                      style={{ width: 22, height: 22, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 600, width: 18, textAlign: "center" }}>{counts[key]}</span>
                    <button onClick={() => setCount(key, counts[key] + 1)}
                      style={{ width: 22, height: 22, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                  </div>
                ))}
              </div>
            </div>

            <button onClick={handleGenerate}
              style={{
                marginTop: 20, padding: "10px 28px", fontSize: 14, fontWeight: 700,
                background: "var(--accent)", color: "#000", border: "none", borderRadius: 8,
                cursor: "pointer", letterSpacing: "-0.01em",
              }}>
              Generate Landscape
            </button>

            {landscape && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    Preview — {landscape.nInt} patches, {landscape.patches.slice(0, landscape.nInt).reduce((s, p) => s + p.population, 0).toLocaleString()} total pop
                  </div>
                  <div style={{ display: "flex", gap: 2, background: "var(--bg3)", borderRadius: 5, padding: 1 }}>
                    {[["archetype", "Type"], ["prevalence", "Baseline PR"]].map(([mode, label]) => (
                      <button key={mode} onClick={() => setMapColorMode(mode)}
                        style={{
                          padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4,
                          border: "none", cursor: "pointer",
                          background: mapColorMode === mode ? "var(--accent)" : "transparent",
                          color: mapColorMode === mode ? "#000" : "var(--text-dim)",
                        }}>{label}</button>
                    ))}
                  </div>
                </div>
                <LandscapeMap landscape={landscape}
                  prevalenceValues={initPrevByPatch}
                  colorMode={mapColorMode}
                  width={Math.min(500, 460)} height={300} />
              </div>
            )}

            {/* Patch characteristics table */}
            {landscape && initPrevByPatch && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>Patch Characteristics</h3>
                <div style={{ maxHeight: 340, overflowY: "auto" }}>
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg2)" }}>
                        <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 600 }}>Patch</th>
                        <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Pop</th>
                        <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Mosq/day</th>
                        <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>M:P</th>
                        <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Access</th>
                        <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Time home</th>
                        <th style={{ textAlign: "center", padding: "4px 6px", fontWeight: 600 }}>Border</th>
                        <th style={{ textAlign: "center", padding: "4px 6px", fontWeight: 600 }}>Baseline PR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {landscape.patches.slice(0, landscape.nInt).map((p, i) => {
                        const mp = (p.emergence / BIONOMICS.mu) / p.population;
                        const n_total = landscape.nTotal;
                        const timeHome = landscape.Theta[i * n_total + i];
                        const cellInputStyle = { width: 52, fontSize: 10, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 3, padding: "2px 4px", textAlign: "right" };
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "4px 6px" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, display: "inline-block", marginRight: 4 }} />
                              {p.name}
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 4px" }}>
                              <input type="number" min={50} max={50000} step={50}
                                value={p.population}
                                onChange={e => updatePatch(i, "population", +e.target.value)}
                                style={cellInputStyle} />
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 4px" }}>
                              <input type="number" min={5} max={5000} step={10}
                                value={Math.round(p.emergence)}
                                onChange={e => updatePatch(i, "emergence", +e.target.value)}
                                style={cellInputStyle} />
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600, color: mp > 5 ? "var(--danger)" : mp > 2 ? "#e8781a" : "var(--text)" }}>
                              {mp.toFixed(1)}
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 4px" }}>
                              <input type="number" min={0} max={100} step={5}
                                value={Math.round(p.access * 100)}
                                onChange={e => updatePatch(i, "access", Math.max(0, Math.min(100, +e.target.value)) / 100)}
                                style={{ ...cellInputStyle, width: 40 }} />
                              <span style={{ fontSize: 9, color: "var(--text-dim)" }}>%</span>
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 6px", color: "var(--text-dim)" }}>
                              {(timeHome * 100).toFixed(0)}%
                            </td>
                            <td style={{ textAlign: "center", padding: "4px 6px" }}>
                              <input type="checkbox" checked={!!p.isBorder}
                                onChange={e => updatePatch(i, "isBorder", e.target.checked)} />
                            </td>
                            <td style={{ textAlign: "center", padding: "4px 4px" }}>
                              <input type="number" min={1} max={90} step={1}
                                value={Math.round(initPrevByPatch[i] * 100)}
                                onChange={e => {
                                  const v = Math.max(1, Math.min(90, +e.target.value)) / 100;
                                  const next = [...initPrevByPatch];
                                  next[i] = Math.round(v * 1000) / 1000;
                                  setInitPrevByPatch(next);
                                  setResults(null);
                                }}
                                style={{ ...cellInputStyle, width: 40, textAlign: "center" }} />
                              <span style={{ fontSize: 9, color: "var(--text-dim)" }}>%</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                  All values are editable. Pop = population (rounded to nearest 50). Mosq/day = daily mosquito emergence. M:P = equilibrium mosquitoes per person (computed). Access = fraction who can reach a health facility. Time home = fraction of time residents spend in own patch (from gravity model). Border = connected to external high-prevalence region. Baseline PR = starting parasite rate.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STRATEGIES TAB */}
      {activeTab === "strategies" && landscape && (
        <div style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {/* Strategy selector / editor */}
            <div style={{ flex: "1 1 420px", minWidth: 320 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                {strategies.map((s, idx) => (
                  <button key={idx} onClick={() => setActiveStrategy(idx)}
                    style={{
                      padding: "6px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6,
                      border: activeStrategy === idx ? `2px solid ${STRATEGY_COLORS[idx]}` : "1px solid var(--border)",
                      background: activeStrategy === idx ? `${STRATEGY_COLORS[idx]}22` : "var(--bg2)",
                      color: activeStrategy === idx ? STRATEGY_COLORS[idx] : "var(--text-dim)",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                    }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: STRATEGY_COLORS[idx] }} />
                    {s.label}
                    {strategies.length > 1 && (
                      <span onClick={e => { e.stopPropagation(); removeStrategy(idx); }}
                        style={{ marginLeft: 4, fontSize: 14, opacity: 0.5, cursor: "pointer" }}>×</span>
                    )}
                  </button>
                ))}
                {strategies.length < 3 && (
                  <button onClick={() => setShowAddModal(true)}
                    style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, border: "1px dashed var(--border)", background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}>
                    + Add Strategy
                  </button>
                )}
              </div>

              {/* Add Strategy Modal */}
              {showAddModal && (
                <div style={{
                  position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                  background: "rgba(0,0,0,0.6)", zIndex: 1000,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }} onClick={() => setShowAddModal(false)}>
                  <div style={{
                    background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12,
                    padding: 24, width: 420, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto",
                  }} onClick={e => e.stopPropagation()}>
                    <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Add Strategy</h3>
                    <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
                      Choose a starting template. You can customize every patch after adding.
                    </div>
                    {["Baseline", "Vector Control", "Case Management", "Combined"].map(group => {
                      const items = TEMPLATES.filter(t => t.group === group);
                      if (items.length === 0) return null;
                      return (
                        <div key={group} style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                            {group}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {items.map(t => (
                              <button key={t.key} onClick={() => addStrategy(t.key)}
                                style={{
                                  padding: "8px 12px", fontSize: 12, textAlign: "left",
                                  background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6,
                                  color: "var(--text)", cursor: "pointer",
                                  transition: "border-color 0.15s",
                                }}
                                onMouseOver={e => e.currentTarget.style.borderColor = "var(--accent)"}
                                onMouseOut={e => e.currentTarget.style.borderColor = "var(--border)"}>
                                {t.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <button onClick={() => setShowAddModal(false)}
                      style={{ marginTop: 8, padding: "6px 16px", fontSize: 12, background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-dim)", cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                {/* Editable strategy name */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>Strategy name</div>
                  <input type="text" value={strategies[activeStrategy]?.label || ""}
                    onChange={e => renameStrategy(activeStrategy, e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, color: STRATEGY_COLORS[activeStrategy], fontSize: 13, fontWeight: 600 }} />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>Template</div>
                  <select value={strategies[activeStrategy]?.template || "none"}
                    onChange={e => setTemplate(activeStrategy, e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13 }}>
                    {TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    {strategies[activeStrategy]?.template === "custom" && <option value="custom">Custom (edited)</option>}
                  </select>
                </div>

                {/* Campaign timing controls */}
                <div style={{ marginBottom: 12, padding: 10, background: "var(--bg3)", borderRadius: 6, border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Campaign Timing
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 12 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text-dim)", minWidth: 90 }}>ITN start year</span>
                      <select value={strategies[activeStrategy]?.config?.itnStartYear ?? 0}
                        onChange={e => {
                          const val = +e.target.value;
                          setStrategies(prev => { const next = [...prev]; next[activeStrategy] = { ...next[activeStrategy], config: { ...next[activeStrategy].config, itnStartYear: val } }; return next; });
                          setResults(null);
                        }}
                        style={{ flex: 1, padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 11 }}>
                        {[0, 1, 2, 3, 4, 5].map(y => <option key={y} value={y}>Year {y}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text-dim)", minWidth: 90 }}>ITN cycle</span>
                      <select value={strategies[activeStrategy]?.config?.itnCycleYears ?? 3}
                        onChange={e => {
                          const val = +e.target.value;
                          setStrategies(prev => { const next = [...prev]; next[activeStrategy] = { ...next[activeStrategy], config: { ...next[activeStrategy].config, itnCycleYears: val } }; return next; });
                          setResults(null);
                        }}
                        style={{ flex: 1, padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 11 }}>
                        {[2, 3, 4, 5].map(y => <option key={y} value={y}>Every {y} years</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text-dim)", minWidth: 90 }}>IRS start year</span>
                      <select value={strategies[activeStrategy]?.config?.irsStartYear ?? 0}
                        onChange={e => {
                          const val = +e.target.value;
                          setStrategies(prev => { const next = [...prev]; next[activeStrategy] = { ...next[activeStrategy], config: { ...next[activeStrategy].config, irsStartYear: val } }; return next; });
                          setResults(null);
                        }}
                        style={{ flex: 1, padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 11 }}>
                        {[0, 1, 2, 3, 4, 5].map(y => <option key={y} value={y}>Year {y}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text-dim)", minWidth: 90 }}>IRS rounds/yr</span>
                      <select value={strategies[activeStrategy]?.config?.irsRoundsPerYear ?? 1}
                        onChange={e => {
                          const val = +e.target.value;
                          setStrategies(prev => { const next = [...prev]; next[activeStrategy] = { ...next[activeStrategy], config: { ...next[activeStrategy].config, irsRoundsPerYear: val } }; return next; });
                          setResults(null);
                        }}
                        style={{ flex: 1, padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 11 }}>
                        {[1, 2].map(r => <option key={r} value={r}>{r} round{r > 1 ? "s" : ""}/year</option>)}
                      </select>
                    </label>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                    ITN efficacy decays between campaigns (half-life ~2.5 yr). IRS wanes faster (~6 mo half-life).
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>
                  Click a patch on the map to edit its interventions, or use the table below.
                </div>

                {/* Per-patch table */}
                {strategies[activeStrategy]?.perPatch && (
                  <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 8 }}>
                    <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                          <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 600 }}>Patch</th>
                          <th style={{ textAlign: "center", padding: "4px 4px", fontWeight: 600 }}>ITN</th>
                          <th style={{ textAlign: "center", padding: "4px 4px", fontWeight: 600 }}>IRS</th>
                          <th style={{ textAlign: "center", padding: "4px 4px", fontWeight: 600 }}>CHW</th>
                          <th style={{ textAlign: "center", padding: "4px 4px", fontWeight: 600 }}>Cure↑</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strategies[activeStrategy].perPatch.map((pp, i) => {
                          const p = landscape.patches[i];
                          return (
                            <tr key={i} onClick={() => setSelectedPatch(i)}
                              style={{
                                cursor: "pointer",
                                background: selectedPatch === i ? "var(--bg3)" : "transparent",
                                borderBottom: "1px solid var(--border)",
                              }}>
                              <td style={{ padding: "4px 6px" }}>
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, display: "inline-block", marginRight: 4 }} />
                                {p.name.replace("Settlement ", "S").replace("Village ", "V").replace("Town ", "T")}
                              </td>
                              <td style={{ textAlign: "center", padding: "4px 4px" }}>
                                <select value={pp.itnCov} onChange={e => {
                                  const next = [...strategies[activeStrategy].perPatch];
                                  next[i] = { ...next[i], itnCov: +e.target.value };
                                  setPerPatch(activeStrategy, next);
                                }} style={{ width: 48, fontSize: 10, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 3, padding: "1px 2px" }}>
                                  {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map(v => <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>)}
                                </select>
                              </td>
                              <td style={{ textAlign: "center", padding: "4px 4px" }}>
                                <select value={pp.irsCov} onChange={e => {
                                  const next = [...strategies[activeStrategy].perPatch];
                                  next[i] = { ...next[i], irsCov: +e.target.value };
                                  setPerPatch(activeStrategy, next);
                                }} style={{ width: 48, fontSize: 10, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 3, padding: "1px 2px" }}>
                                  {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map(v => <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>)}
                                </select>
                              </td>
                              <td style={{ textAlign: "center", padding: "4px 4px" }}>
                                <input type="checkbox" checked={pp.chw} onChange={e => {
                                  const next = [...strategies[activeStrategy].perPatch];
                                  next[i] = { ...next[i], chw: e.target.checked };
                                  setPerPatch(activeStrategy, next);
                                }} />
                              </td>
                              <td style={{ textAlign: "center", padding: "4px 4px" }}>
                                <input type="checkbox" checked={pp.improvedCure > 0} onChange={e => {
                                  const next = [...strategies[activeStrategy].perPatch];
                                  next[i] = { ...next[i], improvedCure: e.target.checked ? 0.95 : 0 };
                                  setPerPatch(activeStrategy, next);
                                }} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Run button */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 16 }}>
                <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 8 }}>
                  Time horizon
                  <input type="range" min={1} max={15} step={1} value={tMaxYears}
                    onChange={e => { setTMaxYears(+e.target.value); setResults(null); }}
                    style={{ width: 100 }} />
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{tMaxYears} yr</span>
                </label>
                <div style={{ flex: 1 }} />
                <button onClick={handleRun} disabled={simRunning}
                  style={{
                    padding: "10px 28px", fontSize: 14, fontWeight: 700,
                    background: simRunning ? "var(--bg3)" : "var(--accent2)",
                    color: "#000", border: "none", borderRadius: 8,
                    cursor: simRunning ? "wait" : "pointer",
                  }}>
                  {simRunning ? "Simulating..." : "Run Simulation →"}
                </button>
              </div>
            </div>

            {/* Map */}
            <div style={{ flex: "0 0 auto" }}>
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>
                    <span style={{ color: STRATEGY_COLORS[activeStrategy] }}>{strategies[activeStrategy]?.label}</span> — Spatial View
                  </div>
                  <div style={{ display: "flex", gap: 2, background: "var(--bg3)", borderRadius: 5, padding: 1 }}>
                    {[["archetype", "Type"], ["prevalence", "Prevalence"]].map(([mode, label]) => (
                      <button key={mode} onClick={() => setMapColorMode(mode)}
                        style={{
                          padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4,
                          border: "none", cursor: "pointer",
                          background: mapColorMode === mode ? "var(--accent)" : "transparent",
                          color: mapColorMode === mode ? "#000" : "var(--text-dim)",
                        }}>{label}</button>
                    ))}
                  </div>
                </div>
                <LandscapeMap landscape={landscape} selectedPatch={selectedPatch}
                  onSelectPatch={setSelectedPatch}
                  strategyPerPatch={strategies[activeStrategy]?.perPatch}
                  prevalenceValues={initPrevByPatch}
                  colorMode={mapColorMode}
                  width={360} height={300} />
                {selectedPatch !== null && strategies[activeStrategy]?.perPatch && (
                  <PatchEditor patch={landscape.patches[selectedPatch]} patchIdx={selectedPatch}
                    perPatch={strategies[activeStrategy].perPatch}
                    onChange={pp => setPerPatch(activeStrategy, pp)} />
                )}              </div>
            </div>
          </div>
        </div>
      )}

      {/* RESULTS TAB */}
      {activeTab === "results" && (
        <div style={{ padding: "20px 24px" }}>
          {simRunning && (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-dim)" }}>
              <div style={{ fontSize: 18, marginBottom: 8 }}>Running simulation...</div>
              <div style={{ fontSize: 12 }}>Solving {strategies.length} × {landscape?.nInt || 0}-patch ODE systems over {tMaxYears} years</div>
            </div>
          )}
          {!simRunning && !results && (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-dim)" }}>
              <div style={{ fontSize: 16 }}>No results yet. Configure strategies and click "Run Simulation".</div>
            </div>
          )}
          {results && !simRunning && (
            <div>
              {/* Prevalence chart */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Zone-Average Prevalence Over Time</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="t" type="number" domain={[0, tMaxYears]}
                      tickFormatter={v => `${v.toFixed(0)}y`}
                      stroke="var(--text-dim)" fontSize={11} />
                    <YAxis tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                      stroke="var(--text-dim)" fontSize={11} domain={[0, "auto"]} />
                    <Tooltip formatter={(v) => `${(v * 100).toFixed(1)}%`}
                      labelFormatter={v => `Year ${v.toFixed(1)}`}
                      contentStyle={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {results.map((r, idx) => {
                      const data = r.times.map((t, i) => ({ t, v: r.zoneAvg[i] }));
                      return <Line key={idx} data={data} dataKey="v" name={r.label}
                        stroke={STRATEGY_COLORS[idx]} strokeWidth={2.5} dot={false}
                        type="monotone" />;
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Summary cards */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                {results.map((r, idx) => {
                  const finalPrev = r.zoneAvg[r.zoneAvg.length - 1];
                  const initPrev = r.zoneAvg[0];
                  const baselineFinal = results[0].zoneAvg[results[0].zoneAvg.length - 1];
                  const reduction = baselineFinal > 0 ? ((baselineFinal - finalPrev) / baselineFinal * 100) : 0;
                  return (
                    <div key={idx} style={{
                      flex: "1 1 200px", background: "var(--bg2)", border: `1px solid ${STRATEGY_COLORS[idx]}44`,
                      borderRadius: 10, padding: 16, borderLeft: `4px solid ${STRATEGY_COLORS[idx]}`,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: STRATEGY_COLORS[idx], marginBottom: 8 }}>
                        {r.label}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 12 }}>
                        <span style={{ color: "var(--text-dim)" }}>Final prevalence</span>
                        <span style={{ fontWeight: 700, textAlign: "right" }}>{(finalPrev * 100).toFixed(1)}%</span>
                        {idx > 0 && <>
                          <span style={{ color: "var(--text-dim)" }}>Relative reduction</span>
                          <span style={{ fontWeight: 700, textAlign: "right", color: reduction > 0 ? "var(--accent2)" : "var(--danger)" }}>
                            {reduction > 0 ? "−" : ""}{Math.abs(reduction).toFixed(0)}%
                          </span>
                        </>}
                        <span style={{ color: "var(--text-dim)" }}>Annual cost</span>
                        <span style={{ fontWeight: 700, textAlign: "right" }}>${r.costs.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        {idx > 0 && reduction > 0 && <>
                          <span style={{ color: "var(--text-dim)" }}>Cost per %pt</span>
                          <span style={{ fontWeight: 700, textAlign: "right" }}>
                            ${(r.costs.total / ((baselineFinal - finalPrev) * 100)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                        </>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Cost breakdown */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Annual Cost Breakdown</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={results.map((r, idx) => ({
                    name: r.label,
                    ITNs: r.costs.breakdown.itn,
                    IRS: r.costs.breakdown.irs,
                    CHWs: r.costs.breakdown.chw,
                    "Cure Impr.": r.costs.breakdown.cure,
                    Overhead: r.costs.breakdown.overhead,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="name" stroke="var(--text-dim)" fontSize={11} />
                    <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                      stroke="var(--text-dim)" fontSize={11} />
                    <Tooltip contentStyle={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                      formatter={(v) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="ITNs" stackId="a" fill="#4363d8" />
                    <Bar dataKey="IRS" stackId="a" fill="#42d4f4" />
                    <Bar dataKey="CHWs" stackId="a" fill="#f58231" />
                    <Bar dataKey="Cure Impr." stackId="a" fill="#e6194b" />
                    <Bar dataKey="Overhead" stackId="a" fill="#911eb4" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Per-patch prevalence detail */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, marginTop: 16 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Final Prevalence by Patch</h3>
                <div style={{ maxHeight: 300, overflowY: "auto" }}>
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>Patch</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>Pop</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>M/P</th>
                        {results.map((r, idx) => (
                          <th key={idx} style={{ textAlign: "right", padding: "4px 6px", color: STRATEGY_COLORS[idx] }}>
                            {r.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {landscape.patches.slice(0, landscape.nInt).map((p, i) => {
                        const mp = (p.emergence / BIONOMICS.mu) / p.population;
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "4px 6px" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, display: "inline-block", marginRight: 4 }} />
                              {p.name}
                            </td>
                            <td style={{ textAlign: "right", padding: "4px 6px" }}>{p.population.toLocaleString()}</td>
                            <td style={{ textAlign: "right", padding: "4px 6px" }}>{mp.toFixed(1)}</td>
                            {results.map((r, idx) => {
                              const prev = r.prevByPatch[i][r.prevByPatch[i].length - 1];
                              return (
                                <td key={idx} style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600, color: STRATEGY_COLORS[idx] }}>
                                  {(prev * 100).toFixed(1)}%
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Before / After prevalence maps */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, marginTop: 16 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Spatial Prevalence: Before → After</h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", overflowX: "auto" }}>
                  {/* Starting prevalence map */}
                  <div style={{ flex: "0 0 auto" }}>
                    <LandscapeMap landscape={landscape}
                      prevalenceValues={initPrevByPatch}
                      colorMode="prevalence"
                      title="Starting"
                      width={220} height={200} compact />
                  </div>
                  {/* Final prevalence for each strategy */}
                  {results.map((r, idx) => {
                    const finalPrevs = [];
                    for (let i = 0; i < landscape.nInt; i++) {
                      finalPrevs.push(r.prevByPatch[i][r.prevByPatch[i].length - 1]);
                    }
                    return (
                      <div key={idx} style={{ flex: "0 0 auto" }}>
                        <LandscapeMap landscape={landscape}
                          prevalenceValues={finalPrevs}
                          colorMode="prevalence"
                          title={r.label}
                          width={220} height={200} compact />
                      </div>
                    );
                  })}
                </div>
                {/* Shared legend */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
                  <span>Prevalence:</span>
                  <div style={{ display: "flex", gap: 0 }}>
                    {[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map(v => (
                      <div key={v} style={{ width: 24, height: 10, background: prevColorScale(v) }} />
                    ))}
                  </div>
                  <span>0%</span>
                  <span style={{ marginLeft: -8 }}>→ 80%+</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ABOUT TAB */}
      {activeTab === "about" && (
        <div style={{ padding: "20px 24px", maxWidth: 800, margin: "0 auto" }}>
          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: 24, fontSize: 13, lineHeight: 1.7, color: "var(--text)" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 700 }}>About This Model</h2>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Overview</h3>
            <p style={{ margin: "0 0 12px" }}>
              This is a deterministic, compartmental spatial malaria transmission model. It simulates <em>Plasmodium falciparum</em> malaria
              across a landscape of interconnected patches (villages, towns, settlements), each with distinct ecology, population, health system
              access, and mosquito density. The model is designed to explore how different intervention strategies — and their spatial targeting —
              affect malaria prevalence, costs, and resurgence risk.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Transmission Dynamics</h3>
            <p style={{ margin: "0 0 12px" }}>
              Within each patch, transmission follows an extended Ross-Macdonald framework with acquired immunity, solved as a system of ordinary differential equations (ODEs).
              The state variables for each patch are:
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>M</strong> — total adult female mosquito population<br/>
              <strong>Y</strong> — mosquitoes incubating (infected but not yet infectious)<br/>
              <strong>Z</strong> — infectious mosquitoes (sporozoite-positive)<br/>
              <strong>I</strong> — infected humans (parasite-positive)<br/>
              <strong>R</strong> — semi-immune humans (recovered, with partial protection)
            </p>
            <p style={{ margin: "0 0 12px" }}>
              Mosquitoes emerge at a fixed rate per patch (representing local ecology), die at a natural death rate augmented by any insecticide-related
              mortality, and feed on humans with a given frequency. Upon feeding on an infectious human, a mosquito enters an incubation
              period (EIP = 10 days), after which it becomes infectious for life.
            </p>
            <p style={{ margin: "0 0 12px" }}>
              Human infection follows an SIRS (Susceptible → Infected → Recovered/Immune → Susceptible) model. Fully susceptible individuals (S = H − I − R) become infected
              at a rate determined by the entomological inoculation rate (EIR). Upon recovery, individuals enter a semi-immune state (R) where they
              have reduced susceptibility to reinfection (α = 0.38, meaning 62% less likely to become infected per bite) and, if reinfected, are less
              infectious to mosquitoes (c reduced by 70%). Immunity wanes over approximately 1.5 years (ω = 1/540 per day) without boosting through
              continued exposure. In high-transmission settings this produces a large immune pool that buffers against dramatic prevalence swings, while
              in low-transmission settings immunity is weak and resurgence is faster after intervention withdrawal.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Spatial Coupling</h3>
            <p style={{ margin: "0 0 12px" }}>
              Patches are coupled through two mechanisms:
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>Human movement</strong> — People divide their time across patches according to a gravity model. The movement matrix Θ defines
              the fraction of time residents of patch j spend in patch i. Attractiveness is proportional to population (with a 1.5× bonus for market towns)
              and decays with distance (exponent = 2). Residents spend at least 85% of their time at home. Border patches additionally have residents
              spending time in the external region (high-prevalence surroundings), creating importation pressure.
            </p>
            <p style={{ margin: "0 0 12px", paddingLeft: 16 }}>
              <strong>Mosquito dispersal</strong> — Adult mosquitoes emigrate between nearby patches at a rate proportional to half their death rate (σ = g/2).
              Dispersal probability decays exponentially with distance (characteristic scale ~1.5 km). This means high-emergence patches "export"
              mosquitoes to neighbors.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Intervention Models</h3>
            <p style={{ margin: "0 0 8px" }}>
              <strong>Insecticide-Treated Nets (ITNs)</strong> — Modeled using the Le Menach feeding cycle framework. When a mosquito attempts
              to feed on a net user, it encounters the net with probability φ = 0.85 (accounting for outdoor/early biting). Given encounter,
              the mosquito is killed with probability d = 0.41, repelled with probability r = 0.56, or successfully feeds with probability s = 0.03.
              This model assumes dual active ingredient nets (e.g., Interceptor G2). After each mass campaign, insecticidal effectiveness decays
              exponentially (half-life ~2.5 years) and physical net retention also decays (half-life ~4 years), producing realistic sawtooth
              dynamics between campaigns.
            </p>
            <p style={{ margin: "0 0 8px" }}>
              <strong>Indoor Residual Spraying (IRS)</strong> — Mosquitoes that successfully feed (including those that passed through ITN protection)
              encounter sprayed walls with probability equal to IRS coverage. Wall-kill probability is 0.60 (calibrated to Actellic 300CS).
              Efficacy decays exponentially with a half-life of ~6 months between spray rounds.
            </p>
            <p style={{ margin: "0 0 8px" }}>
              <strong>Community Health Workers (CHWs)</strong> — Deploying CHWs in a patch extends effective health facility access: people who
              couldn't previously reach a facility now have access through the CHW (access_effective = access + 0.6 × (1 − access)).
              This flows through the treatment cascade to increase the case management rate.
            </p>
            <p style={{ margin: "0 0 12px" }}>
              <strong>Improved Cure Rate</strong> — Represents supply chain improvements, better diagnostics, and health worker training.
              Increases the probability of successful treatment from the baseline 85% to 95%, which also slightly increases care-seeking
              through a quality-of-care feedback effect.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Case Management Cascade</h3>
            <p style={{ margin: "0 0 12px" }}>
              The effective case management rate is computed mechanistically rather than set as an arbitrary parameter. It flows through a
              treatment cascade: an infection must be symptomatic (varies by patch, ~20-40%), the patient must seek care (varies by access
              and care-seeking behavior), and treatment must be successful (cure rate). The resulting rate is added to the natural
              recovery rate: r_eff = r_natural + cm, where cm = (symptomatic × care-seeking × access × cure_rate) / acute_duration.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Landscape Generation</h3>
            <p style={{ margin: "0 0 12px" }}>
              Landscapes are procedurally generated from five patch archetypes: <strong>swamp settlements</strong> (high mosquito density,
              low access), <strong>lakeside villages</strong> (moderate-high density), <strong>inland villages</strong> (moderate),
              <strong>market towns</strong> (lower density, high access, attract movement), and <strong>hill villages</strong> (low density,
              low access, remote). Each archetype has characteristic distributions for population, mosquito emergence, health facility access,
              remoteness, and symptomatic fraction. Patches are placed spatially and connected via the gravity and dispersal models described above.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Key Parameters</h3>
            <div style={{ fontSize: 11, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 20px", padding: "8px 0" }}>
              <span style={{ color: "var(--text-dim)" }}>Mosquito death rate (μ)</span><span>0.1/day (10-day lifespan)</span>
              <span style={{ color: "var(--text-dim)" }}>Feeding rate (f)</span><span>1/3 per day (3-day gonotrophic cycle)</span>
              <span style={{ color: "var(--text-dim)" }}>Human blood index (q)</span><span>0.9</span>
              <span style={{ color: "var(--text-dim)" }}>Extrinsic incubation (EIP)</span><span>10 days</span>
              <span style={{ color: "var(--text-dim)" }}>Transmission efficiency (b)</span><span>0.55</span>
              <span style={{ color: "var(--text-dim)" }}>Natural recovery rate (r)</span><span>1/200 per day (~7 months)</span>
              <span style={{ color: "var(--text-dim)" }}>Human infectiousness (c)</span><span>0.05</span>
              <span style={{ color: "var(--text-dim)" }}>ITN net encounter prob (φ)</span><span>0.85</span>
              <span style={{ color: "var(--text-dim)" }}>ITN efficacy half-life</span><span>2.5 years (dual AI)</span>
              <span style={{ color: "var(--text-dim)" }}>IRS wall-kill prob</span><span>0.60 (Actellic 300CS)</span>
              <span style={{ color: "var(--text-dim)" }}>IRS efficacy half-life</span><span>6 months</span>
              <span style={{ color: "var(--text-dim)" }}>Home time fraction</span><span>≥85%</span>
              <span style={{ color: "var(--text-dim)" }}>Gravity distance exponent</span><span>2.0</span>
              <span style={{ color: "var(--text-dim)" }}>Immune susceptibility (α)</span><span>0.38 (62% reduction)</span>
              <span style={{ color: "var(--text-dim)" }}>Immunity waning (ω)</span><span>1/540 per day (~1.5 yr)</span>
              <span style={{ color: "var(--text-dim)" }}>Immune infectiousness</span><span>0.3× baseline</span>
            </div>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>Key Assumptions & Limitations</h3>
            <p style={{ margin: "0 0 8px" }}>
              This is a simplified model intended for strategic exploration, not operational forecasting. Important simplifications include:
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>Simplified immunity</strong> — The model includes a single-compartment SIRS immunity model where recovered individuals
              gain partial protection that wanes over ~1.5 years. This captures the key qualitative effects (buffered prevalence in endemic areas,
              faster resurgence when immunity wanes during intervention periods) but does not track the full complexity of age-dependent, exposure-driven
              immunity with clinical, anti-infection, and anti-parasite components as in models like malariasimulation.
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>No age structure</strong> — All humans are treated identically. In reality, children bear a disproportionate burden and
              intervention targeting (e.g., SMC) is age-specific.
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>No seasonality</strong> — Mosquito emergence is constant over time. Real transmission is highly seasonal in most settings,
              which affects optimal timing of IRS and other interventions.
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>Deterministic</strong> — The ODE formulation captures average behavior, not stochastic effects. Near elimination, stochastic
              fade-out becomes important and this model will underestimate the probability of local extinction.
            </p>
            <p style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <strong>Simplified costing</strong> — Costs are rough estimates using flat per-person-year rates scaled by remoteness. They do not
              capture economies of scale, procurement variation, or detailed delivery logistics.
            </p>

            <h3 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>References</h3>
            <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--text-dim)" }}>
              Wu SL et al. (2023) "Spatial dynamics of malaria transmission." <em>PLoS Computational Biology</em> 19(6): e1010684.<br/>
              Le Menach A et al. (2007) "An elaborated feeding cycle model for reductions in vectorial capacity of night-biting mosquitoes by insecticide-treated nets." <em>Malaria Journal</em> 6:10.<br/>
              Churcher TS et al. (2016) "The impact of pyrethroid resistance on the efficacy and effectiveness of bednets for malaria control in Africa." <em>eLife</em> 5:e16090.<br/>
              Sherrard-Smith E et al. (2018) "Systematic review of indoor residual spray efficacy and effectiveness against Plasmodium falciparum in Africa." <em>Nature Communications</em> 9:4982.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
