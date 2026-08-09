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
  decodeSurface
} from '../decode.js';
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

export default function renderPerformance({ model }) {
  const takeoff = model.tlr.takeoff;
  const landing = model.tlr.landing;

  const takeoffRunway = takeoff?.runways.find((r) => r.identifier === takeoff.plannedRunway) || takeoff?.runways[0];

  return `
    <div class="cover">
      ${section(t('to.title'), 'aircraft', takeoffSection(model, takeoff, takeoffRunway), {
        action: takeoffRunway?.limitCode
          ? `<span class="sect-flag warn">${escapeHtml(t('to.limitedBy'))}: ${escapeHtml(decodeLimitCode(takeoffRunway.limitCode))}</span>`
          : ''
      })}

      ${section(t('arr.title'), 'aircraft', landingSection(model, landing))}
    </div>
  `;
}

/**
 * Departure end: the field strip, the planned runway in full, the conditions
 * the numbers were computed for, the configuration they assume, and every
 * other runway in case of a late change.
 */
function takeoffSection(model, tlr, runway) {
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
    ${conditionsBody(tlr, runway)}
    ${subHead(t('to.config'))}
    ${configBody(model, tlr, runway)}
    ${subHead(`${t('to.otherRunways')} (${Math.max(0, tlr.runways.length - 1)})`)}
    ${runwayTable(tlr)}
  `;
}

function landingSection(model, tlr) {
  return `
    ${airportHead(
      model.destination,
      'DEST',
      tlr?.runways?.map((r) => r.identifier),
      tlr?.plannedRunway
    )}
    ${subHead(t('arr.landingPerf'))}
    ${landingPerformanceBody(model)}
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

/* Wind first: the component figures are what decides technique. */
function conditionsBody(tlr, runway) {
  const headwind = runway?.headwind;
  const crosswind = runway?.crosswind;
  const isTailwind = Number.isFinite(headwind) && headwind < 0;

  const crosswindTone = !Number.isFinite(crosswind)
    ? ''
    : crosswind >= THRESHOLDS.crosswindCritical
    ? 'bad'
    : crosswind >= THRESHOLDS.crosswindCaution
    ? 'warn'
    : 'good';

  return `
    <div class="perf-wind">
      ${windRose(tlr.windDir, tlr.windSpd, runway?.magneticCourse)}
      <div class="perf-wind-figs">
        <div>
          <span class="k">${escapeHtml(t('common.wind'))}</span>
          <span class="v ltr">${tlr.windDir ?? '—'}° / ${tlr.windSpd ?? '—'} kt</span>
        </div>
        <div>
          <span class="k">${escapeHtml(isTailwind ? t('to.tailwind') : t('to.headwind'))}</span>
          <span class="v ltr ${isTailwind ? 'bad' : 'good'}">${
            Number.isFinite(headwind) ? `${Math.abs(headwind)} kt` : '—'
          }</span>
        </div>
        <div>
          <span class="k">${escapeHtml(t('to.crosswind'))}</span>
          <span class="v ltr ${crosswindTone}">${Number.isFinite(crosswind) ? `${crosswind} kt` : '—'}</span>
        </div>
      </div>
    </div>

    ${fields([
      [t('common.temp'), tlr.temperature === null ? '—' : `${tlr.temperature}°C`],
      [t('common.qnh'), tlr.altimeter === null ? '—' : `${tlr.altimeter} inHg`],
      [t('to.surface'), decodeSurface(tlr.surface) || '—'],
      [t('common.planned'), fmtWeight(tlr.plannedWeight, 'kgs')]
    ])}
  `;
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
