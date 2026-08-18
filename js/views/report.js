/**
 * Post-flight report.
 *
 * The briefing's other chapters answer "what is the plan". This one answers
 * "what actually happened" -- and the only way to say that usefully is to put
 * the two side by side, because a landing fuel of 3,240 kg means nothing until
 * you know the plan said 3,008.
 *
 * It fills in as the flight runs rather than appearing whole at the end: the
 * takeoff stamp gives it the times, each logged reading gives it another
 * fuel point, and touchdown closes it. Read mid-flight it is a progress
 * report; read after landing it is the record.
 */

import { t } from '../i18n.js';
import {
  escapeHtml,
  fmtNumber,
  fmtWeight,
  fmtDuration,
  fmtZulu,
  parseMetar,
  highlightWx,
  flightCategory
} from '../decode.js';
import { section, icon, meter, categoryDot, findingsList } from '../ui.js';
import { fuelCurve } from '../charts.js';
import { getActuals, classify, summarise } from '../fuellog.js';
import { rebasedTimes, actualOff, actualOn, phaseState } from '../timeline.js';
import { runwayWind, alternateWind } from '../wind.js';
import { diffCell } from './navlog.js';

export default function renderReport({ model, findings, timeline, liveMetar }) {
  const clock = rebasedTimes(model, timeline);
  const actuals = getActuals(model);
  const landed = phaseState(timeline, 'landing') === 'done';

  if (!clock.started) {
    return `<div class="cover">
      ${section(t('rep.title'), 'clock', notFlownBody(), {
        action: `<span class="sect-flag">${escapeHtml(t('rep.notStarted'))}</span>`
      })}
    </div>`;
  }

  return `
    <div class="cover">
      ${hero(model, clock, actuals, landed)}
      ${section(t('rep.times'), 'clock', timesBody(model, clock))}
      ${section(t('rep.fuel'), 'routeSwap', fuelBody(model, actuals), {
        action: fuelFlag(model, actuals)
      })}
      ${section(t('nl.fuelCheck'), 'info', fuelLogBody(model, actuals))}
      ${section(t('dep.loading'), 'obstacle', weightsBody(model))}
      ${section(t('rep.weather'), 'ceiling', weatherBody(model, liveMetar))}
      ${
        findings.length
          ? section(t('rep.exceptions'), 'obstacle', findingsList(findings, { showChapter: true }), {
              action: `<span class="sect-flag warn">${findings.length}</span>`
            })
          : section(t('rep.exceptions'), 'obstacle', `<div class="empty-state good">${escapeHtml(t('sum.clean'))}</div>`)
      }
    </div>
  `;
}

function notFlownBody() {
  return `<div class="empty-state">${escapeHtml(t('rep.notStartedHint'))}</div>`;
}

/* -------------------------------------------------------------------- hero */

/**
 * The four figures a crew would read first, large. Each carries what was
 * planned underneath it, because on its own an actual is just a number.
 */
function hero(model, clock, actuals, landed) {
  const units = model.units;
  const summary = summarise(model, actuals);
  const blockPlanned = model.times.estTimeEnroute;
  const blockActual = flownSeconds(clock);
  const landingActual = landingFuel(model, actuals);

  return `<div class="sect ${landed ? 'accent-green' : ''}">
    <div class="rep-hero">
      <div class="rep-hero-head">
        <span class="rep-badge${landed ? ' done' : ''}">
          ${icon(landed ? 'info' : 'clock', { size: 13 })}
          ${escapeHtml(landed ? t('rep.complete') : t('rep.inFlight'))}
        </span>
        <span class="rep-route ltr">
          ${escapeHtml(model.origin?.icao || '')}
          <i>→</i>
          ${escapeHtml(model.destination?.icao || '')}
        </span>
        <span class="rep-ident ltr">${escapeHtml(model.flight.callsign || '')}
          <em>${escapeHtml(model.flight.aircraftIcao || model.flight.aircraft || '')}${
            model.flight.registration ? ` · ${escapeHtml(model.flight.registration)}` : ''
          }</em>
        </span>
      </div>

      <div class="rep-figs">
        ${bigFig({
          label: t('rep.flightTime'),
          actual: fmtDuration(blockActual),
          planned: fmtDuration(blockPlanned),
          delta: deltaSeconds(blockActual, blockPlanned)
        })}
        ${bigFig({
          label: t('rep.landingFuel'),
          actual: landingActual === null ? '—' : fmtWeight(landingActual, units),
          planned: fmtWeight(model.fuel.planLanding, units),
          delta: landingActual === null ? null : deltaWeight(landingActual, model.fuel.planLanding, units, true)
        })}
        ${bigFig({ label: t('rep.burn'), ...burnActual(model, actuals, units) })}
        ${bigFig({ label: t('dep.pax'), actual: paxText(model) })}
      </div>
    </div>
  </div>`;
}

/**
 * One headline figure: what happened, what was planned, and the gap. The gap
 * carries the colour, since it is the only part that can be good or bad.
 */
function bigFig({ label, actual, planned, delta }) {
  return `<div class="rep-fig">
    <span class="k">${escapeHtml(label)}</span>
    <b class="ltr">${actual ?? '—'}</b>
    ${planned ? `<span class="plan ltr">${escapeHtml(t('common.planned'))} ${planned}</span>` : ''}
    ${delta ? `<span class="delta ${delta.tone} ltr">${escapeHtml(delta.text)}</span>` : ''}
  </div>`;
}

/** What the OFP expected to burn between wheels-up and touchdown. */
function plannedBurn(model) {
  return model.fuel.enrouteBurn ?? model.fuel.planTakeoff - model.fuel.planLanding;
}

function paxText(model) {
  const count = model.weights.paxCount;
  if (!Number.isFinite(count)) return '—';
  const max = model.flight.maxPassengers;
  return Number.isFinite(max) ? `${count} <em>/ ${max}</em>` : String(count);
}

/* ------------------------------------------------------------------- deltas */

/**
 * Late or early against a planned wall-clock time.
 *
 * Beyond half a day the two are not the same day's flight -- an OFP flown the
 * following evening would read as a twenty-hour delay -- so the comparison is
 * dropped rather than printed as a number nobody would believe. Durations do
 * not need this: three hours forty-seven is three hours forty-seven whenever
 * it was flown.
 */
export function clockDelta(actual, planned) {
  if (!actual || !planned) return null;
  const diff = Math.round((actual.getTime() - planned.getTime()) / 1000);
  return Math.abs(diff) < 12 * 3600 ? deltaSeconds(diff, 0) : null;
}

/** Late/early against a planned duration. Under is good, over is not. */
function deltaSeconds(actual, planned) {
  if (!Number.isFinite(actual) || !Number.isFinite(planned)) return null;
  const diff = actual - planned;
  if (Math.abs(diff) < 60) return { tone: 'good', text: t('rep.onPlan') };
  return {
    tone: diff > 0 ? 'warn' : 'good',
    text: `${diff > 0 ? '+' : '−'}${fmtDuration(Math.abs(diff))}`
  };
}

/**
 * A weight difference. `moreIsBetter` flips the colouring: landing with more
 * fuel than planned is comfort, burning more than planned is not.
 */
function deltaWeight(actual, planned, units, moreIsBetter = false) {
  if (!Number.isFinite(actual) || !Number.isFinite(planned)) return null;
  const diff = actual - planned;
  if (diff === 0) return { tone: 'good', text: t('rep.onPlan') };

  const favourable = moreIsBetter ? diff > 0 : diff < 0;
  return {
    tone: favourable ? 'good' : Math.abs(diff) > planned * 0.05 ? 'warn' : '',
    text: `${diff > 0 ? '+' : '−'}${fmtWeight(Math.abs(diff), units)}`
  };
}

/* ------------------------------------------------------------------- times */

function timesBody(model, clock) {
  const times = model.times;

  return `<div class="rep-rows">
    ${timeRow(t('ov.etot'), times.estOff, clock.actual?.off)}
    ${timeRow(t('ov.eta'), times.estOn, clock.actual?.onIsMeasured ? clock.actual.on : null, clock.actual?.on)}
    ${timeRow(t('ov.sta'), times.estIn || times.schedIn, null, clock.actual?.in)}
    ${durationRow(t('rep.flightTime'), times.estTimeEnroute, flownSeconds(clock))}
  </div>`;
}

/**
 * Planned against actual for one milestone. A projected time -- one the clock
 * implies but nobody has confirmed -- is shown as such rather than passed off
 * as a measurement.
 */
function timeRow(label, planned, actual, projected) {
  const shown = actual || projected || null;
  const delta = clockDelta(shown, planned);

  return `<div class="rep-row">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v plan ltr">${planned ? escapeHtml(fmtZulu(planned)) : '—'}</span>
    <span class="v ltr${actual ? ' actual' : ' projected'}">
      ${shown ? escapeHtml(fmtZulu(shown)) : '—'}
      ${!actual && projected ? `<i>${escapeHtml(t('rep.projected'))}</i>` : ''}
    </span>
    <span class="d ${delta?.tone || ''} ltr">${delta ? delta.text : ''}</span>
  </div>`;
}

function durationRow(label, planned, actual) {
  const delta = deltaSeconds(actual, planned);
  return `<div class="rep-row">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v plan ltr">${Number.isFinite(planned) ? fmtDuration(planned) : '—'}</span>
    <span class="v actual ltr">${Number.isFinite(actual) ? fmtDuration(actual) : '—'}</span>
    <span class="d ${delta?.tone || ''} ltr">${delta ? delta.text : ''}</span>
  </div>`;
}

/** Time in the air: measured once down, running until then. */
function flownSeconds(clock) {
  if (!clock.started) return null;
  const off = clock.actual.off.getTime();
  const on = clock.actual.onIsMeasured ? clock.actual.on.getTime() : Date.now();
  return Math.max(0, Math.round((on - off) / 1000));
}

/* -------------------------------------------------------------------- fuel */

/** The last reading logged, which is the fuel the aircraft landed with. */
function landingFuel(model, actuals) {
  const logged = model.navlog.filter((f) => Number.isFinite(actuals[f.index]));
  return logged.length ? actuals[logged[logged.length - 1].index] : null;
}

/**
 * Burn is only knowable from two readings, and the crew may not have logged an
 * early one. Rather than invent a departure figure it says so.
 *
 * The planned figure is the plan *over the same stretch* the readings cover,
 * not the whole flight's burn -- comparing a burn measured between the third
 * and the last fix against the full-flight plan would make a matching flight
 * look two tonnes light.
 */
function burnActual(model, actuals, units) {
  const logged = model.navlog.filter((f) => Number.isFinite(actuals[f.index]));

  if (logged.length < 2) {
    return {
      actual: '—',
      planned: fmtWeight(plannedBurn(model), units),
      delta: { tone: '', text: t('rep.needTwo') }
    };
  }

  const first = logged[0];
  const last = logged[logged.length - 1];
  const burnt = actuals[first.index] - actuals[last.index];
  const planned = first.fuelOnBoard - last.fuelOnBoard;
  const partial = first.timeTotal > 0;

  return {
    actual: fmtWeight(burnt, units),
    planned: `${fmtWeight(planned, units)}${partial ? ` <em>${escapeHtml(t('rep.logged'))}</em>` : ''}`,
    delta: deltaWeight(burnt, planned, units)
  };
}

function fuelFlag(model, actuals) {
  const s = summarise(model, actuals);
  if (!s.count) return `<span class="sect-flag">${escapeHtml(t('nl.noReadings'))}</span>`;
  return `<span class="sect-flag">${s.count} ${escapeHtml(t('rep.readings'))}</span>`;
}

function fuelBody(model, actuals) {
  const units = model.units;

  return `
    <div class="rep-rows">
      ${fuelRow(t('dep.blockFuel'), model.fuel.planRamp, null, units)}
      ${fuelRow(t('dep.takeoffFuel'), model.fuel.planTakeoff, null, units)}
      ${fuelRow(t('des.atLanding'), model.fuel.planLanding, landingFuel(model, actuals), units, true)}
      ${fuelRow(t('dep.reserve'), model.fuel.reserve, null, units)}
      ${fuelRow(t('dep.contingency'), model.fuel.contingency, null, units)}
    </div>
    ${fuelCurve(model, actuals)}
  `;
}

function fuelRow(label, planned, actual, units, moreIsBetter = false) {
  const delta = Number.isFinite(actual) ? deltaWeight(actual, planned, units, moreIsBetter) : null;
  return `<div class="rep-row">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v plan ltr">${Number.isFinite(planned) ? fmtWeight(planned, units) : '—'}</span>
    <span class="v ltr${Number.isFinite(actual) ? ' actual' : ''}">${
      Number.isFinite(actual) ? fmtWeight(actual, units) : '—'
    }</span>
    <span class="d ${delta?.tone || ''} ltr">${delta ? delta.text : ''}</span>
  </div>`;
}

/* --------------------------------------------------------------- fuel log */

function fuelLogBody(model, actuals) {
  const logged = model.navlog.filter((f) => Number.isFinite(actuals[f.index]));
  if (!logged.length) {
    return `<div class="empty-state">${escapeHtml(t('rep.noLog'))}</div>`;
  }

  const unit = model.units === 'lbs' ? 'lb' : 'kg';

  return `<div class="table-scroll"><table class="rw-table">
    <thead><tr>
      <th>${escapeHtml(t('nl.ident'))}</th>
      <th>${escapeHtml(t('common.time'))}</th>
      <th>${escapeHtml(t('nl.planned'))} (${unit})</th>
      <th>${escapeHtml(t('nl.actual'))} (${unit})</th>
      <th>${escapeHtml(t('nl.diff'))}</th>
    </tr></thead>
    <tbody>${logged
      .map((fix) => {
        const actual = actuals[fix.index];
        const { state, diff } = classify(fix, actual, model.fuel.contingency, model.fuel.planRamp);
        return `<tr>
          <td><b>${escapeHtml(fix.ident)}</b></td>
          <td>${Number.isFinite(fix.timeTotal) ? fmtDuration(fix.timeTotal) : '—'}</td>
          <td class="dim">${fmtNumber(fix.fuelOnBoard)}</td>
          <td>${fmtNumber(actual)}</td>
          <td>${diffCell(state, diff)}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

/* ----------------------------------------------------------------- weights */

function weightsBody(model) {
  const w = model.weights;
  const units = model.units;

  return `<div class="sect-pad rep-meters">
    ${meter({ label: 'ZFW', value: w.estZfw, max: w.maxZfw, units })}
    ${meter({ label: 'TOW', value: w.estTow, max: w.maxTow, units })}
    ${meter({ label: 'LDW', value: w.estLdw, max: w.maxLdw, units })}
  </div>`;
}

/* ----------------------------------------------------------------- weather */

/**
 * What the weather actually was at each end -- and, if a diversion ever
 * became live, at every filed alternate too. The live observation is
 * preferred over the OFP's snapshot, since by landing the snapshot is hours
 * old.
 */
function weatherBody(model, liveMetar) {
  const live = liveMetar?.state === 'ready' ? liveMetar.metars : {};

  const card = (airport, role, raw, category, wind) => `<div class="rep-wx">
    <div class="rep-wx-head">
      ${categoryDot(category)}
      <span class="role">${escapeHtml(role)}</span>
      <span class="icao ltr">${escapeHtml(airport.icao)}</span>
      ${live[airport.icao] ? `<span class="wxrow-age live">${escapeHtml(t('wx.live'))}</span>` : ''}
      ${
        wind && !wind.calm && !wind.variable
          ? `<span class="grow"></span>
             <span class="rep-wx-wind ltr">${escapeHtml(
               `${Math.abs(wind.headwind)}kt ${wind.headwind < 0 ? t('to.tailShort') : t('to.headShort')} · ${wind.crosswind}kt ${t('to.crosswind')}`
             )}</span>`
          : ''
      }
    </div>
    ${
      wind?.approx
        ? `<div class="rep-wx-approx">${escapeHtml(t('ov.approxRwy'))} ${escapeHtml(wind.runway)}</div>`
        : ''
    }
    <div class="wxrow-text">${highlightWx(raw)}</div>
  </div>`;

  const block = (airport, role, runway) => {
    if (!airport) return '';
    const raw = live[airport.icao] || airport.metar;
    if (!raw) return '';

    const parsed = parseMetar(raw);
    const category = live[airport.icao] ? flightCategory(parsed) : airport.metarCategory;
    const wind = runway ? runwayWind(runway, parsed) : null;
    return card(airport, role, raw, category, wind);
  };

  // No trueCourse exists for an alternate's runway -- SimBrief never computes
  // a full TLR for it -- so the wind here comes from alternateWind(), read
  // off the runway's own number and always captioned approximate rather than
  // shown with the same confidence as the takeoff/landing figures above.
  const altBlock = (airport, role) => {
    if (!airport) return '';
    const raw = live[airport.icao] || airport.metar;
    if (!raw) return '';

    const parsed = parseMetar(raw);
    const category = live[airport.icao] ? flightCategory(parsed) : airport.metarCategory;
    return card(airport, role, raw, category, alternateWind(airport, liveMetar));
  };

  const takeoffRwy = model.tlr.takeoff?.runways.find(
    (r) => r.identifier === model.tlr.takeoff.plannedRunway
  );
  const landingRwy = model.tlr.landing?.runways.find(
    (r) => r.identifier === model.tlr.landing.plannedRunway
  );

  const blocks = `${block(model.origin, t('dep.title'), takeoffRwy)}${block(
    model.destination,
    t('arr.title'),
    landingRwy
  )}${model.alternates
    .map((a, i) => altBlock(a, model.alternates.length > 1 ? `ALTN ${i + 1}` : 'ALTN'))
    .join('')}`;

  return blocks || `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;
}
