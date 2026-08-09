/**
 * Fuel and weights.
 *
 * What the aircraft is carrying and how close each figure sits to its limit:
 * the fuel plan and its breakdown, the margin along the route, the weight
 * limits, and what changing the plan would cost.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtWeight, fmtDuration } from '../decode.js';
import { section, meter, icon } from '../ui.js';
import { fuelCurve, impactsTable } from '../charts.js';

export default function renderFuel({ model }) {
  return `
    <div class="cover">
      ${section(t('dep.fuelPlan'), 'clock', fuelPlanBody(model), { action: enduranceFlag(model) })}
      ${section(t('crz.fuelCurve'), 'routeSwap', fuelCurve(model))}
      ${section(t('dep.loading'), 'obstacle', weightsBody(model), { action: tightestFlag(model) })}
      ${section(t('crz.impacts'), 'info', impactsTable(model))}
    </div>
  `;
}

/* ------------------------------------------------------------------ fuel */

/** Holding time beyond reserve and alternate -- the figure ATC delays eat. */
function holdingMinutes(model) {
  const f = model.fuel;
  const required = (f.reserve || 0) + (f.alternateBurn || 0);
  if (!Number.isFinite(f.planLanding) || !f.avgFlow) return null;
  return Math.floor(((f.planLanding - required) / f.avgFlow) * 60);
}

function enduranceFlag(model) {
  const minutes = holdingMinutes(model);
  if (minutes === null) return '';
  const tone = minutes < 0 ? 'bad' : minutes < 15 ? 'warn' : 'good';
  return `<span class="sect-flag ${tone}">${minutes} ${escapeHtml(t('common.min'))} ${escapeHtml(t('atc.holding'))}</span>`;
}

function fuelPlanBody(model) {
  const f = model.fuel;
  const units = model.units;
  const unitLabel = units === 'lbs' ? 'lb' : 'kg';
  const required = (f.reserve || 0) + (f.alternateBurn || 0);
  const minutes = holdingMinutes(model);

  // Ordered as the fuel is consumed, so the running total reads downward.
  const parts = [
    { label: t('dep.taxi'), value: f.taxi },
    { label: t('dep.enroute'), value: f.enrouteBurn },
    { label: `${t('dep.contingency')} · ${model.flight.contingencyRule || ''}`, value: f.contingency },
    { label: t('dep.alternate'), value: f.alternateBurn, reserve: true },
    { label: t('dep.reserve'), value: f.reserve, reserve: true },
    f.extra ? { label: t('dep.extra'), value: f.extra } : null
  ].filter(Boolean);

  const total = f.planRamp || 0;

  return `
    <div class="figs">
      ${fig(t('dep.blockFuel'), fmtNumber(f.planRamp), unitLabel)}
      ${fig(t('dep.endurance'), fmtDuration(model.times.endurance))}
      ${fig(t('des.atLanding'), fmtNumber(f.planLanding), unitLabel)}
      ${fig(
        t('des.holdingTime'),
        minutes === null ? '—' : String(minutes),
        t('common.min'),
        minutes === null ? '' : minutes < 15 ? 'warn' : 'good'
      )}
    </div>

    <div class="fuel-bars">
      ${parts
        .map(
          (p) => `<div class="fuel-bar ${p.reserve ? 'reserve' : ''}">
            <span class="k">${escapeHtml(p.label)}</span>
            <span class="track"><span class="fill" style="width:${total ? Math.max(1, ((p.value || 0) / total) * 100).toFixed(1) : 0}%"></span></span>
            <span class="v ltr">${fmtWeight(p.value, units)}</span>
          </div>`
        )
        .join('')}
      <div class="fuel-bar total">
        <span class="k">${escapeHtml(t('common.total'))}</span>
        <span class="track"></span>
        <span class="v ltr">${fmtWeight(f.planRamp, units)}</span>
      </div>
    </div>

    <div class="atc-note">
      ${icon('info', { size: 13 })}
      ${escapeHtml(t('fuel.reserveNote'))} ${fmtWeight(required, units)}
    </div>
  `;
}

/* --------------------------------------------------------------- weights */

/** The single closest-to-limit weight, named in the section header. */
function tightestFlag(model) {
  const w = model.weights;
  const margins = [
    { label: 'ZFW', margin: safeMargin(w.maxZfw, w.estZfw) },
    { label: 'TOW', margin: safeMargin(w.maxTow, w.estTow) },
    { label: 'LDW', margin: safeMargin(w.maxLdw, w.estLdw) }
  ].filter((m) => m.margin !== null);

  if (!margins.length) return '';
  const tightest = margins.reduce((best, m) => (m.margin < best.margin ? m : best));
  const tone = tightest.margin < 100 ? 'bad' : tightest.margin < 500 ? 'warn' : 'good';

  return `<span class="sect-flag ${tone}">${escapeHtml(tightest.label)} +${fmtWeight(
    tightest.margin,
    model.units
  )}</span>`;
}

function safeMargin(max, estimate) {
  return Number.isFinite(max) && Number.isFinite(estimate) ? max - estimate : null;
}

function weightsBody(model) {
  const w = model.weights;
  const units = model.units;
  const unitLabel = units === 'lbs' ? 'lb' : 'kg';

  return `
    <div class="figs">
      ${fig(t('dep.pax'), fmtNumber(w.paxCount))}
      ${fig(t('dep.bags'), fmtNumber(w.bagCount))}
      ${fig(t('dep.cargo'), w.cargo === null ? '—' : fmtNumber(w.cargo), unitLabel)}
      ${fig(t('dep.payload'), w.payload === null ? '—' : fmtNumber(w.payload), unitLabel)}
    </div>
    <div class="sect-pad">
      ${meter({ label: t('dep.zfw'), value: w.estZfw, max: w.maxZfw, units })}
      ${meter({ label: t('dep.tow'), value: w.estTow, max: w.maxTow, units })}
      ${meter({ label: t('arr.ldw'), value: w.estLdw, max: w.maxLdw, units })}
    </div>
    <div class="sect-fields">
      ${field(t('dep.oew'), fmtWeight(w.oew, units))}
      ${field(t('dep.ramp'), fmtWeight(w.estRamp, units))}
    </div>
  `;
}

/** One headline figure, in the row shared with the performance screens. */
function fig(label, value, unit = '', tone = '') {
  return `<div class="fig">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr ${tone}">${value}${unit ? `<i> ${escapeHtml(unit)}</i>` : ''}</span>
  </div>`;
}

function field(label, value) {
  return `<div class="sect-field">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value}</span>
  </div>`;
}
