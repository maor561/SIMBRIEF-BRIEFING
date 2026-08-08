/**
 * Chapter 0 — Overview.
 *
 * The briefing cover, laid out the way an airline EFB opens one: three named
 * sections (Schedule, Dispatch, Route) with the title above the panel rather
 * than inside a card header. The schedule band draws the flight as a
 * climb/cruise/descent profile with the milestone times sitting on it.
 *
 * It stays out of the masonry grid on purpose -- this page is a fixed
 * composition read top to bottom, not a wall of independent cards.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtDuration, fmtZulu } from '../decode.js';
import { icon, section } from '../ui.js';
import { dominantCruiseAltitude } from './cruise.js';
import { SEVERITY } from '../analyze.js';

export default function renderOverview({ model, findings }) {
  const critical = findings.filter((f) => f.severity === SEVERITY.CRITICAL).length;

  const watch = findings.length
    ? `<span class="sect-flag ${critical ? 'bad' : 'warn'}">
         ${icon('obstacle', { size: 14 })}${findings.length} ${escapeHtml(t('sum.watchItems'))}
       </span>`
    : `<span class="sect-flag good">${icon('info', { size: 14 })}${escapeHtml(t('sum.clean'))}</span>`;

  return `
    <div class="cover">
      ${section(t('ov.schedule'), 'clock', scheduleBand(model), { action: watch })}
      ${section(t('ov.dispatch'), 'headset', dispatchBody(model))}
      ${section(t('common.route'), 'routeSwap', routeBody(model))}
    </div>
  `;
}

/* ------------------------------------------------------------- schedule */

/*
 * Curve geometry, in viewBox units. The shape is schematic -- it says
 * "ground, climb, cruise, descend, ground", not "this is the vertical
 * profile" -- so it stretches with the panel rather than preserving ratio.
 */
const VB_W = 900;
const VB_H = 150;
const GROUND_Y = 112;
const CRUISE_Y = 30;
const CLIMB_START = 235;
const DESCENT_END = 705;
const MARK_STEP = 68;

const pct = (value, total) => `${((value / total) * 100).toFixed(2)}%`;

/**
 * The schedule band: both airports, the profile curve, and the times a crew
 * is held to. Out-blocks/off/on/in are what the plan is measured against, so
 * they sit on the curve at the point of the flight they belong to rather than
 * in a table somewhere below.
 */
function scheduleBand(model) {
  const times = model.times;
  const cruiseAlt = dominantCruiseAltitude(model) || model.flight.initialAltitude;
  const units = model.units === 'lbs' ? 'lb' : 'kg';

  // Ground milestones, ordered outward from the takeoff/landing moment.
  const before = [
    { key: 'std', time: times.schedOut },
    { key: 'etd', time: times.estOut },
    { key: 'etot', time: times.estOff }
  ].filter((m) => m.time);

  const after = [
    { key: 'eta', time: times.estOn },
    { key: 'sta', time: times.estIn || times.schedIn }
  ].filter((m) => m.time);

  before.forEach((m, i) => {
    m.x = CLIMB_START - (before.length - 1 - i) * MARK_STEP;
  });
  after.forEach((m, i) => {
    m.x = DESCENT_END + i * MARK_STEP;
  });

  const marks = [...before, ...after];

  // Position rides a custom property rather than `left` directly, so the
  // narrow-screen rule can drop the markers into an evenly spaced row by
  // switching to static positioning -- five labels pinned to curve positions
  // collide on a phone. Physical, not logical: the curve runs departure to
  // arrival left-to-right in every language (its containers force LTR), so a
  // logical inset would mirror a marker away from its own dot in RTL.
  const dots = marks
    .map((m) => `<span class="sched-dot" style="--x:${pct(m.x, VB_W)};--y:${pct(GROUND_Y, VB_H)}"></span>`)
    .join('');

  const labels = marks
    .map(
      (m) => `<span class="sched-mark" style="--x:${pct(m.x, VB_W)}">
        <i>${escapeHtml(t(`ov.${m.key}`))}</i>
        <b class="ltr">${escapeHtml(fmtZulu(m.time))}</b>
      </span>`
    )
    .join('');

  const path =
    `M0,${GROUND_Y} L${CLIMB_START},${GROUND_Y} ` +
    `C${CLIMB_START + 55},${GROUND_Y} ${CLIMB_START + 65},${CRUISE_Y} ${CLIMB_START + 105},${CRUISE_Y} ` +
    `L${DESCENT_END - 105},${CRUISE_Y} ` +
    `C${DESCENT_END - 65},${CRUISE_Y} ${DESCENT_END - 55},${GROUND_Y} ${DESCENT_END},${GROUND_Y} ` +
    `L${VB_W},${GROUND_Y}`;

  const fact = (label, value) =>
    `<div><span>${escapeHtml(label)}</span><b class="ltr">${value}</b></div>`;

  return `<div class="sched">
    <div class="sched-top">
      ${port(model.origin, 'start')}
      <span class="sched-callsign ltr">${escapeHtml(model.flight.callsign || model.flight.number || '')}</span>
      ${port(model.destination, 'end')}
    </div>

    <div class="sched-graph">
      <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="sched-curve" d="${path}"/>
      </svg>
      <span class="sched-duration ltr">${fmtDuration(times.estTimeEnroute ?? times.estBlock)}</span>
      <div class="sched-facts">
        ${fact(t('sum.blockFuel'), `${fmtNumber(model.fuel.planRamp)} ${units}`)}
        ${fact(t('ov.groundDistance'), `${fmtNumber(model.route.distance)} nm`)}
        ${fact(t('dep.cruiseAlt'), cruiseAlt ? `FL${Math.round(cruiseAlt / 100)}` : '—')}
      </div>
      ${dots}
    </div>

    <div class="sched-marks">${labels}</div>
  </div>`;
}

function port(airport, side) {
  if (!airport) return '<span></span>';
  const iata = airport.iata ? `${airport.iata} - ` : '';
  return `<div class="sched-port ${side}">
    <b class="ltr">${escapeHtml(airport.icao || '—')}</b>
    <span>${escapeHtml(`${iata}${airport.name || ''}`)}</span>
  </div>`;
}

/* -------------------------------------------------------------- dispatch */

/**
 * Who released the plan and which build of it this is. SimBrief only fills
 * the named crew roles when the account carries them, so the block shows
 * whichever of them actually came through rather than a row of dashes.
 */
function dispatchBody(model) {
  const crew = model.crew;
  const remark = model.dispatch.remark && model.dispatch.remark.toUpperCase() !== 'NONE'
    ? model.dispatch.remark
    : null;

  const rows = [
    [t('ov.dispatcher'), crew.dispatcher],
    [t('ov.captain'), crew.captain],
    [t('ov.firstOfficer'), crew.firstOfficer],
    [t('ov.cabinCrew'), crew.cabin.length ? crew.cabin.join(' · ') : null],
    [t('ov.ofpVersion'), ofpVersion(model.generatedAt)],
    [t('ov.airac'), model.airac],
    [t('ov.ofpLayout'), model.layout]
  ].filter(([, value]) => value);

  return `
    <div class="sect-fields">
      ${rows.map(([label, value]) => field(label, value)).join('')}
    </div>
    ${
      remark
        ? `<div class="sect-field">
             <span class="k">${escapeHtml(t('ov.remarks'))}</span>
             <div class="raw-wx">${escapeHtml(remark)}</div>
           </div>`
        : ''
    }
  `;
}

/** The stamp airline systems print on a release: YYYYMMDD HHMMSS, in Z. */
function ofpVersion(generatedAt) {
  if (!generatedAt) return null;
  const d = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* ----------------------------------------------------------------- route */

function routeBody(model) {
  const route = model.route;

  return `
    <div class="sect-field">
      <span class="k">${escapeHtml(t('ov.atcRoute'))}</span>
      <div class="raw-wx">${escapeHtml(route.text || '—')}</div>
    </div>
    <div class="sect-fields">
      ${field(t('to.sid'), route.sid)}
      ${field(t('des.star'), route.star)}
      ${field(t('sum.airDistance'), route.airDistance ? `${fmtNumber(route.airDistance)} nm` : null)}
      ${field(t('crz.firs'), route.firs.length ? route.firs.join(' · ') : null)}
    </div>
    ${
      route.flightplanText
        ? `<div class="sect-field">
             <span class="k">${escapeHtml(t('dep.atcPlan'))}</span>
             <div class="raw-wx">${escapeHtml(route.flightplanText)}</div>
           </div>`
        : ''
    }
  `;
}

function field(label, value) {
  return `<div class="sect-field">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value ? escapeHtml(value) : '—'}</span>
  </div>`;
}
