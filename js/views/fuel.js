/**
 * Fuel and weights.
 *
 * What the aircraft is carrying and how close each figure sits to its limit:
 * the fuel plan and its breakdown, the margin along the route, the weight
 * limits, and what changing the plan would cost.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtWeight, fmtDuration } from '../decode.js';
import { section, tiles, meter, icon } from '../ui.js';
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
    ${tiles([
      { label: t('dep.blockFuel'), value: fmtNumber(f.planRamp), unit: unitLabel, size: 'big', tone: 'info' },
      { label: t('dep.endurance'), value: fmtDuration(model.times.endurance) },
      { label: t('des.atLanding'), value: fmtNumber(f.planLanding), unit: unitLabel },
      {
        label: t('des.holdingTime'),
        value: minutes === null ? '—' : String(minutes),
        unit: t('common.min'),
        tone: minutes === null ? '' : minutes < 15 ? 'warn' : 'good'
      }
    ])}

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
    ${tiles([
      { label: t('dep.pax'), value: fmtNumber(w.paxCount), size: 'big' },
      { label: t('dep.bags'), value: fmtNumber(w.bagCount) },
      { label: t('dep.cargo'), value: w.cargo === null ? '—' : fmtNumber(w.cargo), unit: unitLabel },
      { label: t('dep.payload'), value: w.payload === null ? '—' : fmtNumber(w.payload), unit: unitLabel }
    ])}
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

function field(label, value) {
  return `<div class="sect-field">
    <span class="k">${escapeHtml(label)}</span>
    <span class="v ltr">${value}</span>
  </div>`;
}
