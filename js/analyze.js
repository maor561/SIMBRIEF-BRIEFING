/**
 * The exception engine.
 *
 * Walks the normalized OFP and produces a flat list of findings. Each chapter
 * renders the findings tagged for it; the summary renders all of them. Keeping
 * every threshold in one table makes them easy to review and tune.
 */

import { t } from './i18n.js';
import {
  fmtFeet,
  fmtNumber,
  fmtWeight,
  notamSeverity,
  notamActiveDuring,
  mentionsRunway,
  parseMetar,
  flightCategory,
  categoryRank
} from './decode.js';
import { runwayWind } from './wind.js';

export const SEVERITY = { CRITICAL: 3, WARNING: 2, INFO: 1 };

/**
 * Tunable limits. Crosswind figures are the common 737-800 numbers; adjust
 * here if operating limits differ.
 */
export const THRESHOLDS = {
  shear: 4,
  isaDeviation: 10,
  windComponentJump: 30,
  moraHigh: 10000,
  weightMarginKg: 500,
  crosswindCaution: 20,
  crosswindCritical: 33,
  landingCrosswindCaution: 25,
  tailwindLimit: 10,
  stopMarginFt: 300,
  fuelMarginLow: 500
};

function finding(severity, chapter, title, detail, extra = {}) {
  return { severity, chapter, title, detail, ...extra };
}

/* ------------------------------------------------------------------ weather */

function checkRouteWeather(model, findings) {
  const fixes = model.navlog;
  if (!fixes.length) return;

  // Per-fix shear and ISA deviation.
  for (const fix of fixes) {
    if (Number.isFinite(fix.shear) && fix.shear >= THRESHOLDS.shear) {
      findings.push(
        finding(
          fix.shear >= THRESHOLDS.shear * 1.5 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          'weather',
          `Wind shear at ${fix.ident}`,
          `Shear value ${fix.shear} at ${fmtFeet(fix.altitude)} — expect turbulence. Wind ${fix.windDir}°/${fix.windSpd}kt.`,
          { fixIndex: fix.index, ident: fix.ident }
        )
      );
    }

  }

  reportIsaDeviation(fixes, findings);

  // Sharp changes in wind component between neighbouring fixes.
  for (let i = 1; i < fixes.length; i += 1) {
    const prev = fixes[i - 1];
    const curr = fixes[i];
    if (!Number.isFinite(prev.windComponent) || !Number.isFinite(curr.windComponent)) continue;
    const delta = curr.windComponent - prev.windComponent;
    if (Math.abs(delta) >= THRESHOLDS.windComponentJump) {
      findings.push(
        finding(
          SEVERITY.WARNING,
          'weather',
          `Sharp wind change ${prev.ident} to ${curr.ident}`,
          `Wind component changes by ${Math.abs(delta)}kt (${prev.windComponent} to ${curr.windComponent}). Expect groundspeed and burn to shift.`,
          { fixIndex: curr.index, ident: curr.ident }
        )
      );
    }
  }

  // Terrain: the single highest MORA on the route, when it is genuinely high.
  const highestMora = fixes.reduce(
    (best, fix) => (Number.isFinite(fix.mora) && (!best || fix.mora > best.mora) ? fix : best),
    null
  );
  if (highestMora && highestMora.mora >= THRESHOLDS.moraHigh) {
    findings.push(
      finding(
        SEVERITY.INFO,
        'weather',
        `High terrain near ${highestMora.ident}`,
        `MORA ${fmtFeet(highestMora.mora)} — relevant to drift-down and depressurisation levels.`,
        { fixIndex: highestMora.index, ident: highestMora.ident }
      )
    );
  }
}

/**
 * ISA deviation, reported once for the route rather than once per fix.
 *
 * A tropical or summer route sits above the threshold almost everywhere, and
 * seven near-identical entries bury the findings that need attention. When the
 * deviation is widespread it is a property of the route, so say it once and
 * name the worst point; only genuinely isolated pockets get their own entry.
 */
function reportIsaDeviation(fixes, findings) {
  const exceeded = fixes.filter(
    (f) => Number.isFinite(f.isaDev) && Math.abs(f.isaDev) >= THRESHOLDS.isaDeviation
  );
  if (!exceeded.length) return;

  const worst = exceeded.reduce((best, f) => (Math.abs(f.isaDev) > Math.abs(best.isaDev) ? f : best));
  const sign = worst.isaDev > 0 ? '+' : '−';
  const magnitude = Math.abs(worst.isaDev);

  if (exceeded.length < 3) {
    for (const fix of exceeded) {
      const fixSign = fix.isaDev > 0 ? '+' : '−';
      findings.push(
        finding(
          SEVERITY.WARNING,
          'weather',
          `Large ISA deviation at ${fix.ident}`,
          `ISA ${fixSign}${Math.abs(fix.isaDev)}°C at ${fmtFeet(fix.altitude)}. Affects climb performance and ceiling.`,
          { fixIndex: fix.index, ident: fix.ident }
        )
      );
    }
    return;
  }

  findings.push(
    finding(
      SEVERITY.WARNING,
      'weather',
      `Air ${worst.isaDev > 0 ? 'warmer' : 'colder'} than standard along most of the route`,
      `${exceeded.length} of ${fixes.length} fixes exceed ${THRESHOLDS.isaDeviation}°C. Peak: ISA ${sign}${magnitude}°C at ${worst.ident}, ${fmtFeet(worst.altitude)}. Affects climb performance and available ceiling.`,
      { fixIndex: worst.index, ident: worst.ident }
    )
  );
}

function checkAirportWeather(model, findings) {
  const entries = [
    { airport: model.origin, chapter: 'weather' },
    { airport: model.destination, chapter: 'weather' },
    ...model.alternates.map((a) => ({ airport: a, chapter: 'weather' }))
  ];

  for (const { airport, chapter } of entries) {
    if (!airport?.metarCategory) continue;
    const category = airport.metarCategory;
    if (category === 'vfr') continue;

    const severity = category === 'lifr' || category === 'ifr' ? SEVERITY.CRITICAL : SEVERITY.WARNING;
    findings.push(
      finding(
        severity,
        chapter,
        `${category.toUpperCase()} conditions at ${airport.icao}`,
        `Visibility ${fmtNumber(airport.metarVisibility)}m, ceiling ${fmtFeet(airport.metarCeiling)}. Check approach minima.`,
        { icao: airport.icao }
      )
    );
  }
}

/* ------------------------------------------------------- weights and fuel */

function checkWeights(model, findings) {
  const w = model.weights;
  const units = model.units;

  const pairs = [
    { est: w.estZfw, max: w.maxZfw, label: 'ZFW', chapter: 'fuel' },
    { est: w.estTow, max: w.maxTow, label: 'TOW', chapter: 'fuel' },
    { est: w.estLdw, max: w.maxLdw, label: 'LDW', chapter: 'fuel' }
  ];

  for (const { est, max, label, chapter } of pairs) {
    if (!Number.isFinite(est) || !Number.isFinite(max)) continue;
    const margin = max - est;

    if (margin < 0) {
      findings.push(
        finding(
          SEVERITY.CRITICAL,
          chapter,
          `${label} exceeded`,
          `Planned ${label} ${fmtWeight(est, units)} against max ${fmtWeight(max, units)} — over by ${fmtWeight(Math.abs(margin), units)}.`,
          { margin, label }
        )
      );
    } else if (margin < THRESHOLDS.weightMarginKg) {
      findings.push(
        finding(
          margin < 100 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          chapter,
          `Tight ${label} margin`,
          `Only ${fmtWeight(margin, units)} left to max ${label} (${fmtWeight(max, units)}). Any added payload or fuel will exceed it.`,
          { margin, label }
        )
      );
    }
  }
}

function checkFuel(model, findings) {
  const units = model.units;

  // Thinnest point between planned fuel on board and the minimum allowed.
  let tightest = null;
  for (const fix of model.navlog) {
    if (!Number.isFinite(fix.fuelOnBoard) || !Number.isFinite(fix.fuelMinOnBoard)) continue;
    const margin = fix.fuelOnBoard - fix.fuelMinOnBoard;
    if (!tightest || margin < tightest.margin) tightest = { fix, margin };
  }

  if (tightest) {
    model.fuelTightest = tightest;
    if (tightest.margin < 0) {
      findings.push(
        finding(
          SEVERITY.CRITICAL,
          'weather',
          'Fuel below minimum enroute',
          `At ${tightest.fix.ident} planned fuel is ${fmtWeight(Math.abs(tightest.margin), units)} below the required minimum.`,
          { fixIndex: tightest.fix.index, ident: tightest.fix.ident }
        )
      );
    } else if (tightest.margin < THRESHOLDS.fuelMarginLow) {
      findings.push(
        finding(
          SEVERITY.WARNING,
          'weather',
          `Tight fuel margin at ${tightest.fix.ident}`,
          `Only ${fmtWeight(tightest.margin, units)} above minimum. A delay or reroute will eat into it.`,
          { fixIndex: tightest.fix.index, ident: tightest.fix.ident }
        )
      );
    }
  }

  // Landing fuel against final reserve plus alternate.
  const required = (model.fuel.reserve || 0) + (model.fuel.alternateBurn || 0);
  if (Number.isFinite(model.fuel.planLanding) && required > 0) {
    const margin = model.fuel.planLanding - required;
    model.landingFuelMargin = margin;
    if (margin < 0) {
      findings.push(
        finding(
          SEVERITY.CRITICAL,
          'fuel',
          'Landing fuel below requirement',
          `Landing fuel ${fmtWeight(model.fuel.planLanding, units)} against ${fmtWeight(required, units)} required (reserve + alternate).`
        )
      );
    } else if (model.fuel.avgFlow && margin / model.fuel.avgFlow < 0.25) {
      findings.push(
        finding(
          SEVERITY.WARNING,
          'fuel',
          'Little holding fuel',
          `Beyond reserve and alternate only ${fmtWeight(margin, units)} remains — under 15 minutes of holding.`
        )
      );
    }
  }
}

/* ------------------------------------------------------------- performance */

function checkRunwayPerformance(model, findings) {
  const sides = [
    { tlr: model.tlr.takeoff, chapter: 'performance', isTakeoff: true },
    { tlr: model.tlr.landing, chapter: 'performance', isTakeoff: false }
  ];

  for (const { tlr, chapter, isTakeoff } of sides) {
    if (!tlr) continue;
    const runway = tlr.runways.find((r) => r.identifier === tlr.plannedRunway);
    if (!runway) continue;

    const crosswindLimit = isTakeoff ? THRESHOLDS.crosswindCaution : THRESHOLDS.landingCrosswindCaution;

    if (Number.isFinite(runway.crosswind)) {
      if (runway.crosswind >= THRESHOLDS.crosswindCritical) {
        findings.push(
          finding(
            SEVERITY.CRITICAL,
            chapter,
            `High crosswind on runway ${runway.identifier}`,
            `${runway.crosswind}kt crosswind — at or beyond the demonstrated limit.`,
            { runway: runway.identifier }
          )
        );
      } else if (runway.crosswind >= crosswindLimit) {
        findings.push(
          finding(
            SEVERITY.WARNING,
            chapter,
            `Significant crosswind on runway ${runway.identifier}`,
            `${runway.crosswind}kt crosswind. Plan technique accordingly.`,
            { runway: runway.identifier }
          )
        );
      }
    }

    // Negative headwind means a tailwind component.
    if (Number.isFinite(runway.headwind) && runway.headwind <= -THRESHOLDS.tailwindLimit) {
      findings.push(
        finding(
          SEVERITY.CRITICAL,
          chapter,
          `Tailwind on runway ${runway.identifier}`,
          `${Math.abs(runway.headwind)}kt tailwind — beyond the usual 10kt limit.`,
          { runway: runway.identifier }
        )
      );
    }

    if (isTakeoff && Number.isFinite(runway.distanceMargin) && runway.distanceMargin < THRESHOLDS.stopMarginFt) {
      findings.push(
        finding(
          runway.distanceMargin < 100 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          chapter,
          `Short stop margin on runway ${runway.identifier}`,
          `Only ${fmtFeet(runway.distanceMargin)} between the reject distance and available runway.`,
          { runway: runway.identifier }
        )
      );
    }

    if (isTakeoff && Number.isFinite(runway.maxWeight) && Number.isFinite(tlr.plannedWeight)) {
      const margin = runway.maxWeight - tlr.plannedWeight;
      if (margin < 0) {
        findings.push(
          finding(
            SEVERITY.CRITICAL,
            chapter,
            `Weight above runway ${runway.identifier} limit`,
            `Planned ${fmtWeight(tlr.plannedWeight, model.units)} against max ${fmtWeight(runway.maxWeight, model.units)}.`,
            { runway: runway.identifier }
          )
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ NOTAMs */

function checkNotams(model, findings) {
  const start = model.times.estOut || model.times.schedOut;
  const end = model.times.estIn || model.times.schedIn;

  const groups = [
    { airport: model.origin, chapter: 'notams' },
    { airport: model.destination, chapter: 'notams' },
    ...model.alternates.map((a) => ({ airport: a, chapter: 'notams' }))
  ];

  for (const { airport, chapter } of groups) {
    if (!airport) continue;
    for (const notam of airport.notams) {
      if (!notamActiveDuring(notam, start, end)) continue;

      const severity = notamSeverity(notam, airport.plannedRunway);
      const isRunway = /runway/i.test(notam.subject || '');

      // Critical items always surface. Runway items one rung down surface too,
      // because a closure elsewhere on the field still shapes the taxi plan.
      if (severity < SEVERITY.CRITICAL && !(severity === SEVERITY.WARNING && isRunway)) continue;

      const hitsPlanned =
        airport.plannedRunway &&
        isRunway &&
        mentionsRunway(`${notam.text || ''} ${notam.raw || ''}`, airport.plannedRunway);

      const title = hitsPlanned
        ? `Planned runway ${airport.plannedRunway} at ${airport.icao} affected by NOTAM`
        : severity === SEVERITY.CRITICAL
        ? `Critical NOTAM at ${airport.icao}`
        : `Other runway closed at ${airport.icao}`;

      // Many closures only bite inside a daily window. We show the schedule
      // rather than trying to parse it, so the crew judges the overlap.
      const notamBody = notam.text || notam.raw || '';
      const scheduleNote = notam.schedule
        ? `\nActive window: ${notam.schedule} — check the overlap with your times.`
        : '';

      findings.push(
        finding(
          hitsPlanned ? SEVERITY.CRITICAL : severity,
          chapter,
          title,
          `${notamBody}${scheduleNote}`,
          { icao: airport.icao, notamId: notam.id }
        )
      );
    }
  }
}

/* ------------------------------------------------------------ live weather */

/**
 * Compares the current observation against the one the plan was built on.
 *
 * Everything else in this file judges the plan against fixed limits. This is
 * the only check that judges the plan against reality, and it is the reason a
 * live METAR is worth fetching at all: the numbers on the other screens were
 * computed for weather that has since moved on.
 */
function checkLiveWeather(model, live, findings) {
  if (!live || live.state !== 'ready') return;

  for (const [airport, role] of [
    [model.origin, t('dep.title')],
    [model.destination, t('arr.title')],
    ...model.alternates.map((a) => [a, t('arr.alternate')])
  ]) {
    const raw = airport && live.metars?.[airport.icao];
    if (!raw || raw === airport.metar) continue;

    const observed = parseMetar(raw);
    const now = flightCategory(observed);
    const planned = airport.metarCategory;

    if (now && planned && categoryRank(now) > categoryRank(planned)) {
      const critical = categoryRank(now) >= 2; // IFR or worse
      findings.push(
        finding(
          critical ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          'weather',
          `${airport.icao} has deteriorated since planning`,
          `Planned ${planned.toUpperCase()}, now ${now.toUpperCase()} on the current observation.`,
          { value: now.toUpperCase(), threshold: planned.toUpperCase(), role }
        )
      );
    }
  }

  checkLiveWind(model, live, findings);
}

/** The live wind resolved onto the runway the takeoff numbers assume. */
function checkLiveWind(model, live, findings) {
  const tlr = model.tlr.takeoff;
  const runway = tlr?.runways.find((r) => r.identifier === tlr.plannedRunway) || tlr?.runways[0];
  const raw = model.origin && live.metars?.[model.origin.icao];
  if (!runway || !raw) return;

  const wind = runwayWind(runway, parseMetar(raw));
  if (!wind || wind.calm || wind.variable) return;

  if (wind.worstCrosswind >= THRESHOLDS.crosswindCritical) {
    findings.push(
      finding(
        SEVERITY.CRITICAL,
        'performance',
        `Crosswind on runway ${runway.identifier} is at the limit`,
        `${wind.worstCrosswind}kt on the current observation; the plan assumed ${runway.crosswind}kt.`,
        { value: wind.worstCrosswind, threshold: THRESHOLDS.crosswindCritical }
      )
    );
  } else if (
    wind.worstCrosswind >= THRESHOLDS.crosswindCaution &&
    runway.crosswind < THRESHOLDS.crosswindCaution
  ) {
    findings.push(
      finding(
        SEVERITY.WARNING,
        'performance',
        `Crosswind on runway ${runway.identifier} has risen`,
        `${runway.crosswind}kt planned, ${wind.worstCrosswind}kt on the current observation.`,
        { value: wind.worstCrosswind, threshold: THRESHOLDS.crosswindCaution }
      )
    );
  }

  // A runway planned into wind and now downwind changes the takeoff case, not
  // just the margin.
  if (runway.headwind > 0 && wind.headwind < 0) {
    findings.push(
      finding(
        wind.worstTailwind >= THRESHOLDS.tailwindLimit ? SEVERITY.CRITICAL : SEVERITY.WARNING,
        'performance',
        `Runway ${runway.identifier} is now downwind`,
        `Planned with ${runway.headwind}kt of headwind; the current observation gives ${Math.abs(wind.headwind)}kt of tailwind.`,
        { value: Math.abs(wind.headwind), threshold: THRESHOLDS.tailwindLimit }
      )
    );
  }
}

/* -------------------------------------------------------------------- entry */

/**
 * Runs every check and returns findings sorted most severe first.
 * Also stashes a couple of derived values on the model that views reuse.
 *
 * `liveMetar` is optional and arrives after the first render, so analyze is
 * re-run when it lands rather than blocking the briefing on the network.
 */
export function analyze(model, liveMetar = null) {
  const findings = [];

  checkRouteWeather(model, findings);
  checkAirportWeather(model, findings);
  checkWeights(model, findings);
  checkFuel(model, findings);
  checkRunwayPerformance(model, findings);
  checkNotams(model, findings);
  checkLiveWeather(model, liveMetar, findings);

  findings.sort((a, b) => b.severity - a.severity);
  findings.forEach((f, i) => {
    f.id = `f${i}`;
  });

  return findings;
}

/** Count of findings per chapter, for the nav badges. */
export function countByChapter(findings) {
  const counts = {};
  for (const f of findings) {
    counts[f.chapter] = counts[f.chapter] || { total: 0, critical: 0 };
    counts[f.chapter].total += 1;
    if (f.severity === SEVERITY.CRITICAL) counts[f.chapter].critical += 1;
  }
  return counts;
}

export function severityLabel(severity) {
  if (severity === SEVERITY.CRITICAL) return t('sev.critical');
  if (severity === SEVERITY.WARNING) return t('sev.warning');
  return t('sev.info');
}

export function severityClass(severity) {
  if (severity === SEVERITY.CRITICAL) return 'sev-critical';
  if (severity === SEVERITY.WARNING) return 'sev-warning';
  return 'sev-info';
}
