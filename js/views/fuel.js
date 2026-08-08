/**
 * Fuel and weights.
 *
 * The planned fuel and what it is made of, how the margin behaves along the
 * route, the weight limits, and what changing the plan would cost.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtWeight, fmtDuration } from '../decode.js';
import { section, tiles, meter, kv } from '../ui.js';
import { fuelCurve, impactsTable } from '../charts.js';

export default function renderFuel({ model }) {
  return `
    <div class="cover">
      ${section(t('dep.fuelPlan'), 'clock', fuelPlanBody(model))}
      ${section(t('crz.fuelCurve'), 'routeSwap', fuelCurve(model))}
      ${section(t('dep.loading'), 'obstacle', weightsBody(model))}
      ${section(t('crz.impacts'), 'info', impactsTable(model))}
    </div>
  `;
}

function fuelPlanBody(model) {
  const f = model.fuel;
  const units = model.units;
  const unitLabel = units === 'lbs' ? 'lb' : 'kg';

  const row = (label, value) =>
    `<div class="row"><span class="grow">${escapeHtml(label)}</span><span class="val">${fmtWeight(value, units)}</span></div>`;

  const required = (f.reserve || 0) + (f.alternateBurn || 0);
  const landingMargin = Number.isFinite(f.planLanding) ? f.planLanding - required : null;
  const holdingMinutes = landingMargin !== null && f.avgFlow ? Math.floor((landingMargin / f.avgFlow) * 60) : null;

  return `
    ${tiles([
      { label: t('dep.blockFuel'), value: fmtNumber(f.planRamp), unit: unitLabel, size: 'big', tone: 'info' },
      { label: t('dep.endurance'), value: fmtDuration(model.times.endurance) },
      { label: t('des.atLanding'), value: fmtNumber(f.planLanding), unit: unitLabel },
      {
        label: t('des.holdingTime'),
        value: holdingMinutes === null ? '—' : String(holdingMinutes),
        unit: t('common.min'),
        tone: holdingMinutes === null ? '' : holdingMinutes < 15 ? 'warn' : 'good'
      }
    ])}
    <div class="rows">
      ${row(t('dep.taxi'), f.taxi)}
      ${row(t('dep.enroute'), f.enrouteBurn)}
      ${row(`${t('dep.contingency')} · ${model.flight.contingencyRule || ''}`, f.contingency)}
      ${row(t('dep.alternate'), f.alternateBurn)}
      ${row(t('dep.reserve'), f.reserve)}
      ${f.extra ? row(t('dep.extra'), f.extra) : ''}
      <div class="row" style="background:var(--panel-2)">
        <span class="grow"><b>${escapeHtml(t('common.total'))}</b></span>
        <span class="val">${fmtWeight(f.planRamp, units)}</span>
      </div>
    </div>
  `;
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
      ${kv([
        [t('dep.oew'), fmtWeight(w.oew, units)],
        [t('dep.ramp'), fmtWeight(w.estRamp, units)]
      ])}
    </div>
  `;
}
