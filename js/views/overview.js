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
import { icon, section, findingsList } from '../ui.js';
import { dominantCruiseAltitude } from '../charts.js';
import { SEVERITY } from '../analyze.js';
import {
  PHASES,
  PHASE_KEYS,
  phaseState,
  phaseElapsed,
  rebasedTimes
} from '../timeline.js';

export default function renderOverview({ model, findings, timeline }) {
  const critical = findings.filter((f) => f.severity === SEVERITY.CRITICAL).length;
  const clock = rebasedTimes(model, timeline);

  // Once the flight is running, how it is running against the plan outranks
  // the findings count in the header -- it is the thing that changes.
  const watch = clock.started
    ? delayFlag(clock)
    : findings.length
    ? `<span class="sect-flag ${critical ? 'bad' : 'warn'}">
         ${icon('obstacle', { size: 14 })}${findings.length} ${escapeHtml(t('sum.watchItems'))}
       </span>`
    : `<span class="sect-flag good">${icon('info', { size: 14 })}${escapeHtml(t('sum.clean'))}</span>`;

  return `
    <div class="cover">
      ${section(t('ov.schedule'), 'clock', scheduleBand(model, timeline), { action: watch })}
      ${section(t('ov.dispatch'), 'headset', dispatchBody(model))}
      ${section(t('common.route'), 'routeSwap', routeBody(model))}
      ${
        model.alternates.length
          ? section(t('ov.diversion'), 'airspace', diversionBody(model), {
              action: `<span class="sect-flag">${escapeHtml(model.alternates.map((a) => a.icao).join(' · '))}</span>`
            })
          : ''
      }
      ${documentsSection(model)}
      ${
        findings.length
          ? section(t('sum.watchItems'), 'obstacle', findingsList(findings, { showChapter: true }), {
              cls: critical ? 'accent-red' : 'accent-amber'
            })
          : ''
      }
    </div>
  `;
}

/**
 * On time, late, or early, against the planned wheels-up. Five minutes either
 * way is not a delay worth a colour.
 *
 * Beyond half a day the two times are not the same day's flight -- an OFP
 * flown the following evening would read as a twenty-hour delay -- so the
 * comparison is dropped rather than reported as a number nobody would believe.
 */
function delayFlag(clock) {
  const seconds = clock.delaySeconds;
  const comparable = Number.isFinite(seconds) && Math.abs(seconds) < 12 * 3600;

  if (!comparable) {
    return `<span class="sect-flag good">${escapeHtml(t('phase.airborne'))}</span>`;
  }
  if (Math.abs(seconds) < 300) {
    return `<span class="sect-flag good">${escapeHtml(t('phase.onTime'))}</span>`;
  }

  const late = seconds > 0;
  return `<span class="sect-flag ${late ? 'warn' : ''}">
    ${escapeHtml(late ? t('phase.late') : t('phase.early'))} <span class="ltr">${fmtDuration(Math.abs(seconds))}</span>
  </span>`;
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
function scheduleBand(model, timeline) {
  const times = model.times;
  const clock = rebasedTimes(model, timeline);
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

  // Once the flight is running each milestone carries its real time under the
  // planned one. The planned figure stays: on its own the actual says when,
  // but the pair says how late.
  const actualFor = (key) => {
    if (!clock.started) return null;
    if (key === 'etot') return clock.actual.off;
    if (key === 'eta') return clock.actual.on;
    if (key === 'sta') return clock.actual.in;
    return null;
  };

  const labels = marks
    .map((m) => {
      const actual = actualFor(m.key);
      return `<span class="sched-mark${actual ? ' has-actual' : ''}" style="--x:${pct(m.x, VB_W)}">
        <i>${escapeHtml(t(`ov.${m.key}`))}</i>
        <b class="ltr">${escapeHtml(fmtZulu(m.time))}</b>
        ${actual ? `<u class="ltr">${escapeHtml(fmtZulu(actual))}</u>` : ''}
      </span>`;
    })
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
        ${fact(t('dep.pax'), paxFigure(model))}
      </div>
      ${dots}
    </div>

    <div class="sched-marks">${labels}</div>
    ${phaseChain(model, timeline)}
  </div>`;
}

/* ---------------------------------------------------------------- phases */

/**
 * The turnaround as a chain of timed phases.
 *
 * Each one is closed by hand, because only the crew knows when fuelling is
 * actually finished. Closing the takeoff phase is the moment the whole
 * briefing stops being a prediction: from there every time on every screen is
 * recomputed off the real wheels-up.
 */
function phaseChain(model, timeline) {
  const now = Date.now();
  const anythingStarted = PHASE_KEYS.some((key) => phaseState(timeline, key) !== 'pending');

  const chips = PHASES.map((phase) => {
    const state = phaseState(timeline, phase.key);
    const elapsed = phaseElapsed(timeline, phase.key, now);
    const expected = expectedSeconds(model, phase);

    // A running phase shows its own clock; a finished one what it took; a
    // pending one what it is expected to take, so the chain reads forward.
    const figure =
      state === 'pending'
        ? expected
          ? `<b class="est ltr">${fmtDuration(expected)}</b>`
          : '<b class="est">—</b>'
        : `<b class="ltr" data-phase-clock="${phase.key}">${fmtDuration(elapsed)}</b>`;

    const over = state !== 'pending' && expected && elapsed > expected * 1.25;

    return `<div class="phase ${state}${over ? ' over' : ''}">
      <i>${escapeHtml(t(phase.labelKey))}</i>
      ${figure}
      ${phaseButton(phase, state)}
    </div>`;
  }).join('');

  return `<div class="phase-chain">
    <div class="phases">${chips}</div>
    ${
      anythingStarted
        ? `<button class="phase-reset" data-action="timeline-reset">${escapeHtml(t('phase.reset'))}</button>`
        : `<div class="phase-hint">${escapeHtml(t('phase.hint'))}</div>`
    }
  </div>`;
}

/**
 * How long a phase should take. Ground handling carries a default; the two
 * flight phases take their length from the plan, which knows better than any
 * constant could.
 */
function expectedSeconds(model, phase) {
  if (phase.key === 'takeoff') return model.times.taxiOut || null;
  if (phase.key === 'landing') return model.times.estTimeEnroute || null;
  return phase.duration || null;
}

function phaseButton(phase, state) {
  if (state === 'done') {
    return `<button class="phase-btn undo" data-action="phase-reopen" data-phase="${phase.key}" title="${escapeHtml(t('phase.undo'))}" aria-label="${escapeHtml(t('phase.undo'))}">${escapeHtml(t('phase.undoShort'))}</button>`;
  }
  if (state === 'running') {
    return `<button class="phase-btn go" data-action="phase-done" data-phase="${phase.key}">${escapeHtml(t(`phase.end.${phase.key}`))}</button>`;
  }
  return `<button class="phase-btn" data-action="phase-start" data-phase="${phase.key}">${escapeHtml(t('phase.start'))}</button>`;
}

/**
 * Passengers, against the type's seating when SimBrief gives it -- "184 / 184"
 * says a full aircraft in a way a bare count does not.
 */
function paxFigure(model) {
  const pax = model.weights.paxCount;
  if (!Number.isFinite(pax)) return '—';
  const seats = model.flight.maxPassengers;
  return Number.isFinite(seats) && seats > 0 ? `${fmtNumber(pax)} / ${fmtNumber(seats)}` : fmtNumber(pax);
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

/* ------------------------------------------------------------- documents */

/**
 * Links out to the sources this briefing was built from. Useful as the
 * authority when a rendered figure looks wrong, and both open externally so
 * nothing here has to reproduce them.
 */
function documentsSection(model) {
  const links = [
    model.links.pdf ? { href: model.links.pdf, label: t('ov.openPdf') } : null,
    model.links.skyvector ? { href: model.links.skyvector, label: t('ov.openMap') } : null
  ].filter(Boolean);

  if (!links.length) return '';

  return section(
    t('ov.documents'),
    'info',
    `<div class="doc-links">${links
      .map(
        (l) => `<a class="doc-link" href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">
          ${icon('info', { size: 15 })}${escapeHtml(l.label)}
        </a>`
      )
      .join('')}</div>`
  );
}

/* ------------------------------------------------------------- diversion */

/**
 * What a diversion actually costs: how far, how long, how much fuel, and by
 * what routing. These are the figures the decision turns on, so they belong
 * on the cover rather than buried with the alternate's weather.
 */
function diversionBody(model) {
  const units = model.units === 'lbs' ? 'lb' : 'kg';

  return model.alternates
    .map((alternate, i) => {
      // SimBrief only routes to the first alternate, so only that one can
      // show a track; any further alternates carry their own figures alone.
      const legs = i === 0 ? model.alternateNavlog : [];

      return `
        ${i ? '<div class="sub-head"></div>' : ''}
        <div class="wx-head">
          <span class="wx-role">ALTN${model.alternates.length > 1 ? ` ${i + 1}` : ''}</span>
          <span class="wx-name ltr">${escapeHtml([alternate.icao, alternate.iata, alternate.name].filter(Boolean).join(' - '))}</span>
        </div>

        <div class="figs">
          ${fig(t('arr.altnDistance'), fmtNumber(alternate.distance), 'nm')}
          ${fig(t('arr.altnEte'), fmtDuration(alternate.ete))}
          ${fig(t('arr.altnBurn'), fmtNumber(alternate.burn), units)}
          ${fig(t('arr.altnCruise'), alternate.cruiseAltitude ? `FL${Math.round(alternate.cruiseAltitude / 100)}` : '—')}
        </div>

        <div class="sect-fields">
          ${field(t('common.runway'), alternate.plannedRunway)}
          ${field(t('common.elevation'), alternate.elevation === null ? null : `${fmtNumber(alternate.elevation)} ft`)}
          ${field(t('common.transLevel'), alternate.transLevel ? `FL${Math.round(alternate.transLevel / 100)}` : null)}
        </div>

        ${
          alternate.route
            ? `<div class="sect-field">
                 <span class="k">${escapeHtml(t('arr.altnRoute'))}</span>
                 <div class="wxrow-text">${escapeHtml(alternate.route)}</div>
               </div>`
            : ''
        }

        ${legs.length ? legTable(legs, model) : ''}
      `;
    })
    .join('');
}

function fig(label, value, unit = '') {
  return `<div class="fig">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value}${unit ? `<i> ${escapeHtml(unit)}</i>` : ''}</span>
  </div>`;
}

/** The routing to the alternate, fix by fix. */
function legTable(legs, model) {
  const rows = legs
    .map(
      (f) => `<tr>
        <td><b>${escapeHtml(f.ident)}</b></td>
        <td>${f.via ? escapeHtml(f.via) : '—'}</td>
        <td>${f.altitude ? fmtNumber(f.altitude) : '—'}</td>
        <td>${Number.isFinite(f.distance) ? fmtNumber(f.distance) : '—'}</td>
        <td>${Number.isFinite(f.timeTotal) ? fmtDuration(f.timeTotal) : '—'}</td>
        <td>${Number.isFinite(f.fuelOnBoard) ? fmtNumber(f.fuelOnBoard) : '—'}</td>
      </tr>`
    )
    .join('');

  return `<div class="table-scroll"><table class="rw-table navlog-table">
    <thead><tr>
      <th>${escapeHtml(t('nl.ident'))}</th>
      <th>${escapeHtml(t('nl.via'))}</th>
      <th>ALT</th>
      <th>${escapeHtml(t('common.distance'))}</th>
      <th>${escapeHtml(t('common.time'))}</th>
      <th>${escapeHtml(t('common.fuel'))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
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
