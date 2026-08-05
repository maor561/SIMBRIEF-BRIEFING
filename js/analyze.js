/**
 * The exception engine.
 *
 * Walks the normalized OFP and produces a flat list of findings. Each chapter
 * renders the findings tagged for it; the summary renders all of them. Keeping
 * every threshold in one table makes them easy to review and tune.
 */

import { t, getLang } from './i18n.js';
import {
  fmtFeet,
  fmtNumber,
  fmtWeight,
  notamSeverity,
  notamActiveDuring,
  mentionsRunway
} from './decode.js';

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

/**
 * Store both languages; render-time code picks the right one.
 * If we called getLang() here, the language would be frozen at creation time,
 * and toggling the language later wouldn't update the findings.
 */
const bilingual = (he, en) => ({ he, en });

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
          'cruise',
          bilingual(`גזירת רוח ב-${fix.ident}`, `Wind shear at ${fix.ident}`),
          bilingual(
            `ערך shear ${fix.shear} בגובה ${fmtFeet(fix.altitude)} — צפויה טלטלה. רוח ${fix.windDir}°/${fix.windSpd}kt.`,
            `Shear value ${fix.shear} at ${fmtFeet(fix.altitude)} — expect turbulence. Wind ${fix.windDir}°/${fix.windSpd}kt.`
          ),
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
          'cruise',
          bilingual(`שינוי חד ברוח בין ${prev.ident} ל-${curr.ident}`, `Sharp wind change ${prev.ident} to ${curr.ident}`),
          bilingual(
            `רכיב הרוח משתנה ב-${Math.abs(delta)}kt (${prev.windComponent} ← ${curr.windComponent}). צפה לשינוי במהירות קרקע ובצריכת דלק.`,
            `Wind component changes by ${Math.abs(delta)}kt (${prev.windComponent} to ${curr.windComponent}). Expect groundspeed and burn to shift.`
          ),
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
        'cruise',
        bilingual(`תבליט גבוה סביב ${highestMora.ident}`, `High terrain near ${highestMora.ident}`),
        bilingual(
          `MORA ${fmtFeet(highestMora.mora)} — רלוונטי לגובה החזרה במקרה של ירידת לחץ או כיבוי מנוע.`,
          `MORA ${fmtFeet(highestMora.mora)} — relevant to drift-down and depressurisation levels.`
        ),
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
          'cruise',
          bilingual(`סטיית ISA חריגה ב-${fix.ident}`, `Large ISA deviation at ${fix.ident}`),
          bilingual(
            `ISA ${fixSign}${Math.abs(fix.isaDev)}°C בגובה ${fmtFeet(fix.altitude)}. משפיע על ביצועי טיפוס ותקרה.`,
            `ISA ${fixSign}${Math.abs(fix.isaDev)}°C at ${fmtFeet(fix.altitude)}. Affects climb performance and ceiling.`
          ),
          { fixIndex: fix.index, ident: fix.ident }
        )
      );
    }
    return;
  }

  findings.push(
    finding(
      SEVERITY.WARNING,
      'cruise',
      bilingual(
        `אוויר ${worst.isaDev > 0 ? 'חם' : 'קר'} מהתקן לאורך רוב המסלול`,
        `Air ${worst.isaDev > 0 ? 'warmer' : 'colder'} than standard along most of the route`
      ),
      bilingual(
        `${exceeded.length} מתוך ${fixes.length} נקודות חורגות מ-${THRESHOLDS.isaDeviation}°C. השיא: ISA ${sign}${magnitude}°C ב-${worst.ident} בגובה ${fmtFeet(worst.altitude)}. משפיע על ביצועי טיפוס ועל התקרה הזמינה.`,
        `${exceeded.length} of ${fixes.length} fixes exceed ${THRESHOLDS.isaDeviation}°C. Peak: ISA ${sign}${magnitude}°C at ${worst.ident}, ${fmtFeet(worst.altitude)}. Affects climb performance and available ceiling.`
      ),
      { fixIndex: worst.index, ident: worst.ident }
    )
  );
}

function checkAirportWeather(model, findings) {
  const entries = [
    { airport: model.origin, chapter: 'departure' },
    { airport: model.destination, chapter: 'arrival' },
    ...model.alternates.map((a) => ({ airport: a, chapter: 'arrival' }))
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
        bilingual(`תנאי ${category.toUpperCase()} ב-${airport.icao}`, `${category.toUpperCase()} conditions at ${airport.icao}`),
        bilingual(
          `ראות ${fmtNumber(airport.metarVisibility)}m, תקרה ${fmtFeet(airport.metarCeiling)}. בדוק מינימות גישה.`,
          `Visibility ${fmtNumber(airport.metarVisibility)}m, ceiling ${fmtFeet(airport.metarCeiling)}. Check approach minima.`
        ),
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
    { est: w.estZfw, max: w.maxZfw, label: 'ZFW', chapter: 'departure' },
    { est: w.estTow, max: w.maxTow, label: 'TOW', chapter: 'takeoff' },
    { est: w.estLdw, max: w.maxLdw, label: 'LDW', chapter: 'arrival' }
  ];

  for (const { est, max, label, chapter } of pairs) {
    if (!Number.isFinite(est) || !Number.isFinite(max)) continue;
    const margin = max - est;

    if (margin < 0) {
      findings.push(
        finding(
          SEVERITY.CRITICAL,
          chapter,
          bilingual(`חריגה ב-${label}`, `${label} exceeded`),
          bilingual(
            `${label} מתוכנן ${fmtWeight(est, units)} מול מקסימום ${fmtWeight(max, units)} — חריגה של ${fmtWeight(Math.abs(margin), units)}.`,
            `Planned ${label} ${fmtWeight(est, units)} against max ${fmtWeight(max, units)} — over by ${fmtWeight(Math.abs(margin), units)}.`
          ),
          { margin, label }
        )
      );
    } else if (margin < THRESHOLDS.weightMarginKg) {
      findings.push(
        finding(
          margin < 100 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          chapter,
          bilingual(`מרווח ${label} צר`, `Tight ${label} margin`),
          bilingual(
            `נותרו ${fmtWeight(margin, units)} בלבד עד מקסימום ${label} (${fmtWeight(max, units)}). כל תוספת מטען או דלק תחרוג.`,
            `Only ${fmtWeight(margin, units)} left to max ${label} (${fmtWeight(max, units)}). Any added payload or fuel will exceed it.`
          ),
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
          'cruise',
          bilingual('דלק מתחת למינימום בנתיב', 'Fuel below minimum enroute'),
          bilingual(
            `ב-${tightest.fix.ident} הדלק המתוכנן נמוך ב-${fmtWeight(Math.abs(tightest.margin), units)} מהמינימום הנדרש.`,
            `At ${tightest.fix.ident} planned fuel is ${fmtWeight(Math.abs(tightest.margin), units)} below the required minimum.`
          ),
          { fixIndex: tightest.fix.index, ident: tightest.fix.ident }
        )
      );
    } else if (tightest.margin < THRESHOLDS.fuelMarginLow) {
      findings.push(
        finding(
          SEVERITY.WARNING,
          'cruise',
          bilingual(`מרווח דלק צר ב-${tightest.fix.ident}`, `Tight fuel margin at ${tightest.fix.ident}`),
          bilingual(
            `רק ${fmtWeight(tightest.margin, units)} מעל המינימום. עיכוב או הסטה יצרכו את המרווח.`,
            `Only ${fmtWeight(tightest.margin, units)} above minimum. A delay or reroute will eat into it.`
          ),
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
          'descent',
          bilingual('דלק נחיתה מתחת לנדרש', 'Landing fuel below requirement'),
          bilingual(
            `דלק בנחיתה ${fmtWeight(model.fuel.planLanding, units)} מול ${fmtWeight(required, units)} נדרשים (רזרבה + חלופי).`,
            `Landing fuel ${fmtWeight(model.fuel.planLanding, units)} against ${fmtWeight(required, units)} required (reserve + alternate).`
          )
        )
      );
    } else if (model.fuel.avgFlow && margin / model.fuel.avgFlow < 0.25) {
      findings.push(
        finding(
          SEVERITY.WARNING,
          'descent',
          bilingual('מעט דלק להחזקה', 'Little holding fuel'),
          bilingual(
            `מעבר לרזרבה ולחלופי נותרו ${fmtWeight(margin, units)} — פחות מ-15 דקות החזקה.`,
            `Beyond reserve and alternate only ${fmtWeight(margin, units)} remains — under 15 minutes of holding.`
          )
        )
      );
    }
  }
}

/* ------------------------------------------------------------- performance */

function checkRunwayPerformance(model, findings) {
  const sides = [
    { tlr: model.tlr.takeoff, chapter: 'takeoff', isTakeoff: true },
    { tlr: model.tlr.landing, chapter: 'arrival', isTakeoff: false }
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
            bilingual(`רוח צד גבוהה במסלול ${runway.identifier}`, `High crosswind on runway ${runway.identifier}`),
            bilingual(
              `${runway.crosswind}kt רוח צד — בגבול או מעל מגבלת ההדגמה של המטוס.`,
              `${runway.crosswind}kt crosswind — at or beyond the demonstrated limit.`
            ),
            { runway: runway.identifier }
          )
        );
      } else if (runway.crosswind >= crosswindLimit) {
        findings.push(
          finding(
            SEVERITY.WARNING,
            chapter,
            bilingual(`רוח צד משמעותית במסלול ${runway.identifier}`, `Significant crosswind on runway ${runway.identifier}`),
            bilingual(`${runway.crosswind}kt רוח צד. שקול טכניקת נחיתה/המראה מתאימה.`, `${runway.crosswind}kt crosswind. Plan technique accordingly.`),
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
          bilingual(`רוח גב במסלול ${runway.identifier}`, `Tailwind on runway ${runway.identifier}`),
          bilingual(
            `${Math.abs(runway.headwind)}kt רוח גב — מעל מגבלת 10kt המקובלת.`,
            `${Math.abs(runway.headwind)}kt tailwind — beyond the usual 10kt limit.`
          ),
          { runway: runway.identifier }
        )
      );
    }

    if (isTakeoff && Number.isFinite(runway.distanceMargin) && runway.distanceMargin < THRESHOLDS.stopMarginFt) {
      findings.push(
        finding(
          runway.distanceMargin < 100 ? SEVERITY.CRITICAL : SEVERITY.WARNING,
          chapter,
          bilingual(`מרווח עצירה קצר במסלול ${runway.identifier}`, `Short stop margin on runway ${runway.identifier}`),
          bilingual(
            `נותרו ${fmtFeet(runway.distanceMargin)} בלבד בין מרחק העצירה לאורך המסלול הזמין.`,
            `Only ${fmtFeet(runway.distanceMargin)} between the reject distance and available runway.`
          ),
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
            bilingual(`משקל מעל מגבלת המסלול ${runway.identifier}`, `Weight above runway ${runway.identifier} limit`),
            bilingual(
              `משקל מתוכנן ${fmtWeight(tlr.plannedWeight, model.units)} מול מקסימום ${fmtWeight(runway.maxWeight, model.units)}.`,
              `Planned ${fmtWeight(tlr.plannedWeight, model.units)} against max ${fmtWeight(runway.maxWeight, model.units)}.`
            ),
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
    { airport: model.origin, chapter: 'departure' },
    { airport: model.destination, chapter: 'arrival' },
    ...model.alternates.map((a) => ({ airport: a, chapter: 'arrival' }))
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
        ? bilingual(
            `המסלול המתוכנן ${airport.plannedRunway} ב-${airport.icao} מושפע מ-NOTAM`,
            `Planned runway ${airport.plannedRunway} at ${airport.icao} affected by NOTAM`
          )
        : severity === SEVERITY.CRITICAL
        ? bilingual(`NOTAM קריטי ב-${airport.icao}`, `Critical NOTAM at ${airport.icao}`)
        : bilingual(`סגירת מסלול אחר ב-${airport.icao}`, `Other runway closed at ${airport.icao}`);

      // Many closures only bite inside a daily window. We show the schedule
      // rather than trying to parse it, so the crew judges the overlap.
      const scheduleNote = notam.schedule
        ? bilingual(`\nחלון פעילות: ${notam.schedule} — ודא חפיפה לזמן הטיסה.`, `\nActive window: ${notam.schedule} — check the overlap with your times.`)
        : '';

      findings.push(
        finding(
          hitsPlanned ? SEVERITY.CRITICAL : severity,
          chapter,
          title,
          `${notam.text || notam.raw || ''}${scheduleNote}`,
          { icao: airport.icao, notamId: notam.id }
        )
      );
    }
  }
}

/* -------------------------------------------------------------------- entry */

/**
 * Runs every check and returns findings sorted most severe first.
 * Also stashes a couple of derived values on the model that views reuse.
 */
export function analyze(model) {
  const findings = [];

  checkRouteWeather(model, findings);
  checkAirportWeather(model, findings);
  checkWeights(model, findings);
  checkFuel(model, findings);
  checkRunwayPerformance(model, findings);
  checkNotams(model, findings);

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
