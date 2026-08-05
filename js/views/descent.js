/**
 * Chapter 4 — Descent.
 *
 * This is where the diversion and holding decisions get made, so the
 * destination weather and the landing fuel margin live here rather than in the
 * arrival chapter.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtFeet, fmtWeight, fmtDuration, fmtZulu, windComponents } from '../decode.js';
import {
  card,
  flushCard,
  tiles,
  kv,
  chip,
  meter,
  windRose,
  fixList,
  chapterHeading,
  chapterFindings,
  tafBlock,
  metarBlock,
  joinParts
} from '../ui.js';

export default function renderDescent({ model, findings }) {
  const destination = model.destination;
  const eta = model.times.estOn || model.times.schedOn;

  return `
    ${chapterHeading(t('des.title'), joinParts([model.flight.descentProfile, model.route.star]))}

    <div class="grid">
      ${findings.some((f) => f.chapter === 'descent') ? `<div class="col-12">${chapterFindings(findings, 'descent')}</div>` : ''}

      <div class="col-5">
        ${flushCard({ title: t('des.tod'), hint: t('des.todHint'), body: todBody(model) })}
      </div>

      <div class="col-7">
        ${flushCard({ title: t('des.fuelMargin'), body: fuelMarginBody(model) })}
      </div>

      <div class="col-7">
        ${flushCard({ title: joinParts([t('des.star'), model.route.star], ' — '), body: starBody(model) })}
      </div>

      <div class="col-5">
        ${card({ title: t('des.landingWind'), body: landingWindBody(model) })}
      </div>

      <div class="col-6">
        ${card({ title: `${t('des.destWx')} — ${destination?.icao || ''}`, body: metarBlock(destination) })}
      </div>

      <div class="col-6">
        ${flushCard({
          title: `${t('wx.taf')} — ${destination?.icao || ''}`,
          hint: eta ? `${t('des.expectedAtEta')} ${fmtZulu(eta)}` : '',
          body: tafBlock(destination, eta)
        })}
      </div>

      <div class="col-12">
        ${flushCard({ title: t('des.terrain'), body: terrainBody(model) })}
      </div>
    </div>
  `;
}

/* Top of descent: where it starts and what is left to run from there. */
function todBody(model) {
  const tod = model.topOfDescent;
  if (!tod) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  // Distance and time still to run at the TOD fix.
  const remaining = model.navlog
    .filter((f) => f.index > tod.index)
    .reduce((sum, f) => sum + (f.distance || 0), 0);
  const totalTime = model.times.estTimeEnroute;
  const timeToGo = Number.isFinite(totalTime) && Number.isFinite(tod.timeTotal) ? totalTime - tod.timeTotal : null;

  return `
    ${tiles([
      { label: t('des.tod'), value: escapeHtml(tod.ident), size: 'big', tone: 'info' },
      { label: 'FL', value: tod.altitude ? `FL${Math.round(tod.altitude / 100)}` : '—', size: 'big' },
      { label: t('des.toGo'), value: fmtNumber(remaining), unit: 'nm' },
      { label: t('common.time'), value: timeToGo === null ? '—' : fmtDuration(timeToGo) }
    ])}
    <div style="padding:11px 13px">
      ${kv([
        [t('des.fuelAtTod'), tod.fuelOnBoard ? fmtWeight(tod.fuelOnBoard, model.units) : '—'],
        [t('des.profile'), model.flight.descentProfile || '—'],
        [t('common.transLevel'), model.destination?.transLevel ? `FL${Math.round(model.destination.transLevel / 100)}` : '—'],
        [t('common.wind'), `${tod.windDir ?? '—'}° / ${tod.windSpd ?? '—'} kt`]
      ])}
    </div>
  `;
}

/**
 * Fuel at landing against what has to remain. The holding figure is what a
 * crew actually reasons with when ATC offers a delay.
 */
function fuelMarginBody(model) {
  const fuel = model.fuel;
  const required = (fuel.reserve || 0) + (fuel.alternateBurn || 0);
  const margin = Number.isFinite(fuel.planLanding) ? fuel.planLanding - required : null;
  const holdingMinutes = margin !== null && fuel.avgFlow ? Math.floor((margin / fuel.avgFlow) * 60) : null;

  const tone = margin === null ? '' : margin < 0 ? 'bad' : holdingMinutes !== null && holdingMinutes < 15 ? 'warn' : 'good';

  return `
    ${tiles([
      { label: t('des.atLanding'), value: fmtNumber(fuel.planLanding), unit: model.units === 'lbs' ? 'lb' : 'kg', size: 'big' },
      { label: t('des.required'), value: fmtNumber(required), unit: model.units === 'lbs' ? 'lb' : 'kg' },
      { label: t('common.margin'), value: margin === null ? '—' : fmtNumber(margin), unit: model.units === 'lbs' ? 'lb' : 'kg', tone, size: 'big' },
      { label: t('des.holdingTime'), value: holdingMinutes === null ? '—' : String(holdingMinutes), unit: t('common.min'), tone }
    ])}
    <div style="padding:11px 13px">
      <div class="rows">
        <div class="row"><span class="grow">${escapeHtml(t('dep.alternate'))} · ${escapeHtml(model.alternates[0]?.icao || '')}</span><span class="val">${fmtWeight(fuel.alternateBurn, model.units)}</span></div>
        <div class="row"><span class="grow">${escapeHtml(t('dep.reserve'))}</span><span class="val">${fmtWeight(fuel.reserve, model.units)}</span></div>
        <div class="row"><span class="grow">${escapeHtml(t('dep.contingency'))}</span><span class="val">${fmtWeight(fuel.contingency, model.units)}</span></div>
      </div>
    </div>
  `;
}

function starBody(model) {
  const arrival = model.navlog.filter((f) => f.index > (model.topOfDescent?.index ?? -1));
  if (!arrival.length) return `<div class="empty-state">${escapeHtml(t('common.none'))}</div>`;
  return fixList(arrival);
}

/* Runway wind at arrival, derived from the forecast wind at the landing fix. */
function landingWindBody(model) {
  const tlr = model.tlr.landing;
  const runway = tlr?.runways.find((r) => r.identifier === tlr.plannedRunway);

  // Prefer the TLR figures; fall back to computing from the last navlog fix.
  let headwind = runway?.headwind;
  let crosswind = runway?.crosswind;
  let source = 'TLR';

  if ((!Number.isFinite(headwind) || !Number.isFinite(crosswind)) && runway?.magneticCourse) {
    const last = model.navlog[model.navlog.length - 1];
    const computed = windComponents(last?.windDir, last?.windSpd, runway.magneticCourse);
    if (computed) {
      headwind = computed.headwind;
      crosswind = computed.crosswind;
      source = last.ident;
    }
  }

  const isTailwind = Number.isFinite(headwind) && headwind < 0;

  return `
    <div style="display:flex;gap:13px;align-items:center;margin-block-end:11px">
      ${windRose(tlr?.windDir, tlr?.windSpd, runway?.magneticCourse)}
      <div>
        <div class="num" style="font-size:19px;font-weight:700">${tlr?.windDir ?? '—'}° / ${tlr?.windSpd ?? '—'} kt</div>
        <div style="font-size:11.5px;color:var(--dimmer)">${escapeHtml(t('common.runway'))} ${escapeHtml(tlr?.plannedRunway || '—')} · ${escapeHtml(source)}</div>
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
        tone: !Number.isFinite(crosswind) ? '' : crosswind >= 25 ? 'bad' : crosswind >= 15 ? 'warn' : 'good'
      }
    ])}
  `;
}

/* Highest terrain from TOD onward, and the fixes that drive it. */
function terrainBody(model) {
  const descent = model.navlog.filter((f) => f.index >= (model.topOfDescent?.index ?? 0));
  const highest = descent.reduce((best, f) => (Number.isFinite(f.mora) && (!best || f.mora > best.mora) ? f : best), null);

  if (!highest) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  return `
    ${tiles([
      { label: t('des.highestMora'), value: fmtFeet(highest.mora), size: 'big', tone: 'warn' },
      { label: t('common.none') === '' ? '' : 'FIX', value: escapeHtml(highest.ident) },
      { label: t('common.transLevel'), value: model.destination?.transLevel ? `FL${Math.round(model.destination.transLevel / 100)}` : '—' }
    ])}
    <div style="padding:0 13px 11px">
      ${descent
        .filter((f) => Number.isFinite(f.mora))
        .map(
          (f) => `<div class="row" style="padding-inline:0">
            <span class="grow"><span class="ltr">${escapeHtml(f.ident)}</span></span>
            <span class="val" style="color:${f.mora === highest.mora ? 'var(--amber)' : 'var(--dim)'}">${fmtFeet(f.mora)}</span>
          </div>`
        )
        .join('')}
    </div>
  `;
}
