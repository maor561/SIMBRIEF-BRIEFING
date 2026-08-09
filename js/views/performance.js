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
  fmtNumber,
  fmtFeet,
  fmtWeight,
  decodeLimitCode,
  decodeSurface
} from '../decode.js';
import {
  section,
  tiles,
  kv,
  chip,
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

/* The headline card: speeds, then the runway drawn to scale. */
function takeoffBody(model, tlr, runway) {
  if (!runway) return notAvailable();

  const units = model.units;
  const hasSpeeds = runway.v1 || runway.vr || runway.v2;

  return `
    ${tiles([
      { label: 'V1', value: runway.v1 ?? '—', size: 'huge' },
      { label: 'VR', value: runway.vr ?? '—', size: 'huge' },
      { label: 'V2', value: runway.v2 ?? '—', size: 'huge' },
      runway.vref ? { label: runway.vrefId || 'VREF', value: runway.vref, size: 'big', tone: 'info' } : null
    ])}
    ${hasSpeeds ? '' : `<div class="img-note" style="padding:9px 15px 0">${escapeHtml(t('common.notAvailable'))} — V-speeds</div>`}

    <div class="sect-pad">
      ${runwayBar(runway)}
      ${kv([
        [t('to.decide'), runway.distanceDecide ? fmtFeet(runway.distanceDecide) : '—'],
        [t('to.reject'), runway.distanceReject ? fmtFeet(runway.distanceReject) : '—'],
        [t('to.stopMargin'), marginCell(runway.distanceMargin)],
        [t('to.continue'), runway.distanceContinue ? fmtFeet(runway.distanceContinue) : '—']
      ])}
    </div>

    <div class="sect-pad" style="padding-block-start:0">
      ${meter({
        label: t('to.weightLimit'),
        value: tlr.plannedWeight,
        max: runway.maxWeight,
        units,
        warnBelow: 500,
        badBelow: 0
      })}
      ${kv([
        ['TORA', runway.tora ? fmtFeet(runway.tora) : '—'],
        ['TODA', runway.toda ? fmtFeet(runway.toda) : '—'],
        ['ASDA', runway.asda ? fmtFeet(runway.asda) : '—'],
        [t('arr.gradient'), runway.gradient === null ? '—' : `${runway.gradient}%`],
        ['ILS', runway.ils || '—']
      ])}
    </div>
  `;
}

function marginCell(margin) {
  if (!Number.isFinite(margin)) return '—';
  const tone = margin < 100 ? 'var(--red)' : margin < THRESHOLDS.stopMarginFt ? 'var(--amber)' : 'var(--green)';
  return `<span style="color:${tone}">${fmtFeet(margin)}</span>`;
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
    <div class="sect-pad">
      <div style="display:flex;gap:14px;align-items:center;margin-block-end:12px">
        ${windRose(tlr.windDir, tlr.windSpd, runway?.magneticCourse)}
        <div>
          <div class="num" style="font-size:20px;font-weight:700">${tlr.windDir ?? '—'}° / ${tlr.windSpd ?? '—'} kt</div>
          <div style="font-size:11.5px;color:var(--dimmer)">${escapeHtml(t('common.wind'))}</div>
        </div>
      </div>
    </div>

    ${tiles([
      {
        label: isTailwind ? t('to.tailwind') : t('to.headwind'),
        value: Number.isFinite(headwind) ? String(Math.abs(headwind)) : '—',
        unit: 'kt',
        size: 'big',
        tone: isTailwind ? 'bad' : 'good'
      },
      {
        label: t('to.crosswind'),
        value: Number.isFinite(crosswind) ? String(crosswind) : '—',
        unit: 'kt',
        size: 'big',
        tone: crosswindTone
      }
    ])}

    <div class="sect-pad">
      ${kv([
        [t('common.temp'), tlr.temperature === null ? '—' : `${tlr.temperature}°C`],
        [t('common.qnh'), tlr.altimeter === null ? '—' : `${tlr.altimeter} inHg`],
        [t('to.surface'), decodeSurface(tlr.surface) || '—'],
        [t('common.planned'), fmtWeight(tlr.plannedWeight, 'kgs')]
      ])}
    </div>
  `;
}

function configBody(model, tlr, runway) {
  return `<div class="sect-pad">${kv([
    [t('to.flap'), runway?.flap || tlr.flap || '—'],
    [t('to.thrust'), runway?.thrust || '—'],
    [t('to.bleeds'), runway?.bleed || '—'],
    [t('to.antiIce'), runway?.antiIce || '—'],
    [t('to.flex'), runway?.flexTemp ? `${runway.flexTemp}°C` : '—'],
    [t('to.climbProfile'), model.flight.climbProfile || '—'],
    [t('to.initialAlt'), model.flight.initialAltitude ? fmtFeet(model.flight.initialAltitude) : '—'],
    [t('common.transAlt'), model.origin?.transAlt ? fmtFeet(model.origin.transAlt) : '—']
  ])}</div>`;
}
