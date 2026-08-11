/**
 * Performance.
 *
 * The takeoff and landing runway analysis SimBrief ships as TLR: the planned
 * runway in full, then every runway it evaluated so a late change has numbers
 * ready.
 */

import { t } from '../i18n.js';
import {
  escapeHtml,
  fmtFeet,
  fmtWeight,
  decodeLimitCode,
  decodeSurface,
  parseMetar
} from '../decode.js';
import { runwayWind } from '../wind.js';
import {
  section,
  meter,
  windRose,
  runwayBar,
  runwayTable,
  airportHead,
  landingPerformanceBody
} from '../ui.js';
import { THRESHOLDS } from '../analyze.js';

export default function renderPerformance({ model, liveMetar }) {
  const takeoff = model.tlr.takeoff;
  const landing = model.tlr.landing;

  const takeoffRunway = takeoff?.runways.find((r) => r.identifier === takeoff.plannedRunway) || takeoff?.runways[0];

  return `
    <div class="cover">
      ${section(t('to.title'), 'aircraft', takeoffSection(model, takeoff, takeoffRunway, liveWind(model.origin, takeoffRunway, liveMetar)), {
        action: takeoffRunway?.limitCode
          ? `<span class="sect-flag warn">${escapeHtml(t('to.limitedBy'))}: ${escapeHtml(decodeLimitCode(takeoffRunway.limitCode))}</span>`
          : ''
      })}

      ${section(
        t('arr.title'),
        'aircraft',
        landingSection(model, landing, liveWind(model.destination, landingRunway(landing), liveMetar))
      )}
    </div>
  `;
}

/**
 * The current wind resolved onto the runway the numbers were computed for.
 * Returns null unless a live observation actually arrived, so the screen falls
 * back to the plan alone rather than showing an empty comparison.
 */
export function liveWind(airport, runway, liveMetar) {
  if (!airport || !runway || liveMetar?.state !== 'ready') return null;
  const raw = liveMetar.metars?.[airport.icao];
  if (!raw) return null;
  const resolved = runwayWind(runway, parseMetar(raw));
  return resolved ? { ...resolved, at: liveMetar.fetchedAt } : null;
}

/**
 * Departure end: the field strip, the planned runway in full, the conditions
 * the numbers were computed for, the configuration they assume, and every
 * other runway in case of a late change.
 */
function takeoffSection(model, tlr, runway, live) {
  if (!tlr) return notAvailable();

  return `
    ${airportHead(
      model.origin,
      'DEP',
      tlr.runways.map((r) => r.identifier),
      tlr.plannedRunway
    )}
    ${subHead(`${t('to.perfFor')} — ${runway?.identifier || ''}`)}
    ${takeoffBody(model, tlr, runway)}
    ${subHead(t('to.conditions'))}
    ${conditionsBody(tlr, runway, live)}
    ${subHead(t('to.config'))}
    ${configBody(model, tlr, runway)}
    ${subHead(`${t('to.otherRunways')} (${Math.max(0, tlr.runways.length - 1)})`)}
    ${runwayTable(tlr)}
  `;
}

/** The runway the landing figures were computed for. */
function landingRunway(tlr) {
  return tlr?.runways.find((r) => r.identifier === tlr.plannedRunway) || tlr?.runways[0] || null;
}

function landingSection(model, tlr, live) {
  return `
    ${airportHead(
      model.destination,
      'DEST',
      tlr?.runways?.map((r) => r.identifier),
      tlr?.plannedRunway
    )}
    ${subHead(t('arr.landingPerf'))}
    ${landingPerformanceBody(model, live)}
    ${
      tlr
        ? `${subHead(`${t('to.otherRunways')} (${Math.max(0, tlr.runways.length - 1)})`)}
           ${runwayTable(tlr, { landing: true })}`
        : ''
    }
  `;
}

/** A labelled divider inside a section, so one panel can hold several blocks. */
function subHead(title) {
  return `<div class="sub-head">${escapeHtml(title)}</div>`;
}

function notAvailable() {
  return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;
}

/* Speeds first, then the runway drawn to scale, then the geometry. */
function takeoffBody(model, tlr, runway) {
  if (!runway) return notAvailable();

  const hasSpeeds = runway.v1 || runway.vr || runway.v2;

  return `
    <div class="figs">
      ${speed('V1', runway.v1)}
      ${speed('VR', runway.vr)}
      ${speed('V2', runway.v2)}
      ${runway.vref ? speed(runway.vrefId || 'VREF', runway.vref) : ''}
    </div>
    ${
      hasSpeeds
        ? ''
        : `<div class="atc-note">${escapeHtml(t('common.notAvailable'))} — V-speeds</div>`
    }

    <div class="sect-pad">${runwayBar(runway)}</div>

    ${fields([
      [t('to.decide'), runway.distanceDecide ? fmtFeet(runway.distanceDecide) : '—'],
      [t('to.reject'), runway.distanceReject ? fmtFeet(runway.distanceReject) : '—'],
      [t('to.stopMargin'), marginValue(runway.distanceMargin)],
      [t('to.continue'), runway.distanceContinue ? fmtFeet(runway.distanceContinue) : '—'],
      ['TORA', runway.tora ? fmtFeet(runway.tora) : '—'],
      ['TODA', runway.toda ? fmtFeet(runway.toda) : '—'],
      ['ASDA', runway.asda ? fmtFeet(runway.asda) : '—'],
      [t('arr.gradient'), runway.gradient === null ? '—' : `${runway.gradient}%`],
      ['ILS', runway.ils || '—']
    ])}

    <div class="sect-pad">
      ${meter({
        label: t('to.weightLimit'),
        value: tlr.plannedWeight,
        max: runway.maxWeight,
        units: model.units,
        warnBelow: 500,
        badBelow: 0
      })}
    </div>
  `;
}

function speed(label, value) {
  return `<div class="fig">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value ?? '—'}</span>
  </div>`;
}

function marginValue(margin) {
  if (!Number.isFinite(margin)) return '—';
  const tone = margin < 100 ? 'bad' : margin < THRESHOLDS.stopMarginFt ? 'warn' : 'good';
  return `<span class="${tone}">${fmtFeet(margin)}</span>`;
}

/*
 * Wind first: the component figures are what decides technique.
 *
 * When a live observation is in, each figure gets a second column. The planned
 * number is what the takeoff data assumes; the live one is what the aircraft
 * will actually meet, and the gap between them is the reason to look.
 */
function conditionsBody(tlr, runway, live) {
  const headwind = runway?.headwind;
  const crosswind = runway?.crosswind;
  const isTailwind = Number.isFinite(headwind) && headwind < 0;

  return `
    <div class="perf-wind">
      ${windRose(tlr.windDir, tlr.windSpd, runway?.magneticCourse)}
      <div class="perf-wind-figs${live ? ' compare' : ''}">
        ${live ? windCompareHead() : ''}
        ${windRow(
          t('common.wind'),
          `${tlr.windDir ?? '—'}° / ${tlr.windSpd ?? '—'} kt`,
          '',
          live && liveWindText(live),
          ''
        )}
        ${windRow(
          t('to.alongRunway'),
          alongText(headwind),
          isTailwind ? 'bad' : 'good',
          live && alongText(live.headwind, live.worstTailwind),
          live && live.worstTailwind > 0 ? 'bad' : 'good'
        )}
        ${windRow(
          t('to.crosswind'),
          Number.isFinite(crosswind) ? `${crosswind} kt` : '—',
          crosswindTone(crosswind),
          live && crossText(live.crosswind, live.worstCrosswind),
          live && crosswindTone(live.worstCrosswind)
        )}
      </div>
    </div>
    ${live ? windDelta(crosswind, headwind, live) : ''}

    ${fields([
      [t('common.temp'), tlr.temperature === null ? '—' : `${tlr.temperature}°C`],
      [t('common.qnh'), tlr.altimeter === null ? '—' : `${tlr.altimeter} inHg`],
      [t('to.surface'), decodeSurface(tlr.surface) || '—'],
      [t('common.planned'), fmtWeight(tlr.plannedWeight, 'kgs')]
    ])}
  `;
}

function crosswindTone(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= THRESHOLDS.crosswindCritical) return 'bad';
  if (value >= THRESHOLDS.crosswindCaution) return 'warn';
  return 'good';
}

function windCompareHead() {
  return `<div class="perf-wind-row head">
    <span class="k"></span>
    <span class="v">${escapeHtml(t('common.planned'))}</span>
    <span class="v">${escapeHtml(t('perf.now'))}</span>
  </div>`;
}

/* Both value cells carry markup their builders assembled from numbers and
 * translated labels, so neither is escaped here. */
function windRow(label, planned, plannedTone, liveText, liveTone) {
  return `<div class="perf-wind-row">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr ${plannedTone}">${planned}</span>
    ${liveText === undefined || liveText === null || liveText === false ? '' : `<span class="v ltr live ${liveTone || ''}">${liveText}</span>`}
  </div>`;
}

function liveWindText(live) {
  if (live.calm) return 'CALM';
  if (live.variable) return `VRB ${live.speed ?? '—'} kt`;
  const gust = live.gustSpeed ? `G${live.gustSpeed}` : '';
  return escapeHtml(`${String(live.direction).padStart(3, '0')}° / ${live.speed}${gust} kt`);
}

/**
 * The along-runway component, carrying its own sense.
 *
 * Head and tail share one row because they are one number with a sign, but the
 * sign is the whole story -- the planned wind can be a headwind and the live
 * one a tailwind off the same runway. Naming it in the cell means neither
 * column can be read under the other's label.
 */
function alongText(component, worstTailwind) {
  if (!Number.isFinite(component)) return '—';

  const sense = component < 0 ? t('to.tailShort') : t('to.headShort');
  const text = `${Math.abs(component)} kt <i>${sense}</i>`;

  // A gust or a variable arc can turn a headwind into a tailwind; that worst
  // case belongs beside the steady figure, not hidden behind it.
  return Number.isFinite(worstTailwind) && worstTailwind > Math.max(0, -component)
    ? `${text} <i>· ${worstTailwind} ${t('to.tailShort')} max</i>`
    : text;
}

/**
 * The steady crosswind, and behind it the worst the wind is entitled to reach
 * given its gust and any variable arc -- the figure a limit is checked
 * against, shown whenever it differs from the steady one.
 */
function crossText(steady, worst) {
  if (!Number.isFinite(steady)) return '—';
  return worst > steady ? `${steady} kt <i>${worst} max</i>` : `${steady} kt`;
}

/**
 * Says out loud when the live wind has moved the takeoff away from what was
 * planned. Silent when nothing meaningful changed -- a line that always shows
 * up stops being read.
 */
function windDelta(plannedCrosswind, plannedHeadwind, live) {
  const notes = [];
  const worst = live.worstCrosswind;

  if (Number.isFinite(worst) && Number.isFinite(plannedCrosswind)) {
    const change = worst - plannedCrosswind;
    if (worst >= THRESHOLDS.crosswindCritical) {
      notes.push({
        tone: 'bad',
        text: `${t('perf.xwNow')} ${worst} kt — ${t('perf.xwOverLimit')} (${THRESHOLDS.crosswindCritical} kt).`
      });
    } else if (worst >= THRESHOLDS.crosswindCaution && plannedCrosswind < THRESHOLDS.crosswindCaution) {
      notes.push({ tone: 'warn', text: `${t('perf.xwRose')} ${plannedCrosswind} → ${worst} kt.` });
    } else if (Math.abs(change) >= 8) {
      notes.push({ tone: '', text: `${t('perf.xwChanged')} ${plannedCrosswind} → ${worst} kt.` });
    }
  }

  const plannedTail = Number.isFinite(plannedHeadwind) && plannedHeadwind < 0 ? -plannedHeadwind : 0;
  if (live.worstTailwind >= 10 && live.worstTailwind > plannedTail) {
    notes.push({ tone: 'bad', text: `${t('perf.tailNow')} ${live.worstTailwind} kt.` });
  } else if (plannedHeadwind > 0 && live.headwind < 0) {
    // Not a matter of degree: the runway was planned into wind and is now
    // downwind, which lengthens the takeoff roll rather than shortening it.
    notes.push({
      tone: 'warn',
      text: `${t('perf.senseFlip')} ${plannedHeadwind} kt ${t('to.headShort')} → ${Math.abs(live.headwind)} kt ${t('to.tailShort')}.`
    });
  }

  if (!notes.length) return '';
  return notes
    .map((n) => `<div class="atc-note ${n.tone}">${escapeHtml(n.text)}</div>`)
    .join('');
}

function configBody(model, tlr, runway) {
  return fields([
    [t('to.flap'), runway?.flap || tlr.flap || '—'],
    [t('to.thrust'), runway?.thrust || '—'],
    [t('to.bleeds'), runway?.bleed || '—'],
    [t('to.antiIce'), runway?.antiIce || '—'],
    [t('to.flex'), runway?.flexTemp ? `${runway.flexTemp}°C` : '—'],
    [t('to.climbProfile'), model.flight.climbProfile || '—'],
    [t('to.initialAlt'), model.flight.initialAltitude ? fmtFeet(model.flight.initialAltitude) : '—'],
    [t('common.transAlt'), model.origin?.transAlt ? fmtFeet(model.origin.transAlt) : '—']
  ]);
}

/** The label/value grid the rest of the briefing uses. */
function fields(pairs) {
  return `<div class="sect-fields">${pairs
    .map(
      ([label, value]) => `<div class="sect-field">
        <span class="k">${escapeHtml(label)}</span>
        <span class="v ltr">${value}</span>
      </div>`
    )
    .join('')}</div>`;
}
