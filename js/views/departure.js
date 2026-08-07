/**
 * Chapter 1 — Departure airport.
 * What gets briefed at the gate, before pushback.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtWeight, fmtDuration, fmtZulu, fmtNumber } from '../decode.js';
import {
  card,
  flushCard,
  collapsible,
  tiles,
  meter,
  kv,
  icon,
  categoryDot,
  chapterHeading,
  chapterFindings,
  airportIdentity,
  metarBlock,
  tafBlock,
  atisBlock,
  notamCard,
  sigmetCard
} from '../ui.js';
import { dominantCruiseAltitude } from './cruise.js';

export default function renderDeparture({ model, findings }) {
  const airport = model.origin;
  if (!airport) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const etd = model.times.estOff || model.times.schedOff;
  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  return `
    ${chapterHeading(`${airport.icao} · ${airport.name || ''}`, t('dep.title'), categoryDot(airport.metarCategory))}

    <div class="grid">
      <div class="col-12">${flushCard({ headless: true, body: flightGlanceBody(model) })}</div>

      <div class="col-12">${flushCard({ title: t('common.runway'), headless: true, body: airportIdentity(airport) })}</div>

      ${findings.some((f) => f.chapter === 'departure') ? `<div class="col-12">${chapterFindings(findings, 'departure')}</div>` : ''}

      <div class="col-7">
        ${card({ title: t('wx.metar'), body: metarBlock(airport) })}
      </div>

      <div class="col-5">
        ${card({ title: t('dep.loading'), body: loadingBody(model) })}
      </div>

      <div class="col-7">
        ${collapsible({ title: t('wx.taf'), hint: t('des.expectedAtEta'), body: tafBlock(airport, etd) })}
      </div>

      <div class="col-5">
        ${flushCard({ title: t('dep.fuelPlan'), body: fuelBody(model) })}
      </div>

      <div class="col-7">
        ${notamCard(airport, window)}
      </div>

      <div class="col-5">
        ${collapsible({ title: t('dep.times'), body: timesBody(model) })}
      </div>

      <div class="col-12">${sigmetCard(model)}</div>

      <div class="col-12">${atisBlock(airport)}</div>

      <div class="col-12">
        ${collapsible({
          title: t('common.route'),
          body: routeBody(model)
        })}
      </div>
    </div>
  `;
}

/**
 * The whole flight read as a journey, not a table: departure and destination
 * anchor the two ends, the route line between them carries the level and
 * cost index a crew would otherwise have to go find in the cruise chapter,
 * and the alternate branches off visibly rather than competing for the same
 * weight as the primary airports.
 */
function flightGlanceBody(model) {
  const cruiseAlt = dominantCruiseAltitude(model) || model.flight.initialAltitude;
  const etd = model.times.estOff || model.times.schedOff;
  const eta = model.times.estOn || model.times.schedOn;
  const altn = model.alternates[0];

  return `
    <div class="glance">
      <div class="glance-flight">
        <span class="glance-label">${escapeHtml(t('dep.flightNumber'))}</span>
        <span class="glance-flightnum ltr">${escapeHtml(model.flight.number || model.flight.callsign || '—')}</span>
      </div>

      <div class="glance-route">
        <div class="glance-endpoint">
          <span class="glance-icao">${escapeHtml(model.origin?.icao || '—')}</span>
          <span class="glance-time">${escapeHtml(t('header.etd'))} <b class="ltr">${escapeHtml(fmtZulu(etd))}</b></span>
        </div>

        <div class="glance-path">
          <span class="glance-level ltr">${cruiseAlt ? `FL${Math.round(cruiseAlt / 100)}` : '—'} · CI ${model.flight.costIndex ?? '—'}</span>
          <span class="glance-line"><span class="glance-plane">${icon('aircraft')}</span></span>
          <span class="glance-duration ltr">${fmtDuration(model.times.estTimeEnroute ?? model.times.estBlock)}</span>
        </div>

        <div class="glance-endpoint">
          <span class="glance-icao">${escapeHtml(model.destination?.icao || '—')}</span>
          <span class="glance-time">${escapeHtml(t('dep.landingTime'))} <b class="ltr">${escapeHtml(fmtZulu(eta))}</b></span>
        </div>
      </div>

      ${
        altn
          ? `<div class="glance-altn">
               <span class="glance-label">${escapeHtml(t('dep.alternate'))}</span>
               <span class="glance-altn-icao ltr">${escapeHtml(altn.icao)}</span>
             </div>`
          : ''
      }
    </div>
  `;
}

/* Loading: the payload figures, then the two margins that can bite. */
function loadingBody(model) {
  const w = model.weights;
  const units = model.units;

  return `
    ${tiles([
      { label: t('dep.pax'), value: fmtNumber(w.paxCount), size: 'big' },
      { label: t('dep.bags'), value: fmtNumber(w.bagCount) },
      { label: t('dep.cargo'), value: w.cargo === null ? '—' : fmtNumber(w.cargo), unit: units === 'lbs' ? 'lb' : 'kg' },
      { label: t('dep.payload'), value: w.payload === null ? '—' : fmtNumber(w.payload), unit: units === 'lbs' ? 'lb' : 'kg' }
    ])}
    <div style="padding-block-start:11px">
      ${meter({ label: t('dep.zfw'), value: w.estZfw, max: w.maxZfw, units })}
      ${meter({ label: t('dep.tow'), value: w.estTow, max: w.maxTow, units })}
      ${kv([[t('dep.oew'), fmtWeight(w.oew, units)], [t('dep.ramp'), fmtWeight(w.estRamp, units)]])}
    </div>
  `;
}

/* Fuel: the block figure up top, then how it breaks down. */
function fuelBody(model) {
  const f = model.fuel;
  const units = model.units;
  const row = (label, value, tone = '') =>
    `<div class="row"><span class="grow">${escapeHtml(label)}</span><span class="val ${tone}">${fmtWeight(value, units)}</span></div>`;

  return `
    ${tiles([
      { label: t('dep.blockFuel'), value: fmtNumber(f.planRamp), unit: units === 'lbs' ? 'lb' : 'kg', size: 'big', tone: 'info' },
      { label: t('dep.endurance'), value: fmtDuration(model.times.endurance), hint: t('common.time') }
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

function timesBody(model) {
  const times = model.times;
  const pair = (label, sched, est) => `<div class="row">
    <span class="grow">${escapeHtml(label)}</span>
    <span class="val" style="color:var(--dim)">${escapeHtml(fmtZulu(sched))}</span>
    <span class="val">${escapeHtml(fmtZulu(est))}</span>
  </div>`;

  return `
    <div class="row" style="background:var(--panel-2);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dimmer)">
      <span class="grow"></span>
      <span class="val" style="color:var(--dimmer)">${escapeHtml(t('dep.sched'))}</span>
      <span class="val" style="color:var(--dimmer)">${escapeHtml(t('dep.est'))}</span>
    </div>
    <div class="rows">
      ${pair(t('dep.out'), times.schedOut, times.estOut)}
      ${pair(t('dep.off'), times.schedOff, times.estOff)}
      ${pair(t('dep.on'), times.schedOn, times.estOn)}
      ${pair(t('dep.in'), times.schedIn, times.estIn)}
      <div class="row">
        <span class="grow">${escapeHtml(t('dep.taxiOut'))}</span>
        <span class="val">${escapeHtml(fmtDuration(times.taxiOut))}</span>
      </div>
    </div>
  `;
}

function routeBody(model) {
  const route = model.route;
  return `
    ${kv([
      [t('to.sid'), route.sid ? `<span class="ltr">${escapeHtml(route.sid)}</span>` : '—'],
      [t('des.star'), route.star ? `<span class="ltr">${escapeHtml(route.star)}</span>` : '—'],
      [t('common.distance'), `${fmtNumber(route.distance)} nm`],
      [t('sum.airDistance'), `${fmtNumber(route.airDistance)} nm`]
    ])}
    <div class="raw-wx" style="margin-block-start:11px">${escapeHtml(route.text || '')}</div>
    ${
      route.flightplanText
        ? `<div style="margin-block-start:11px">
             <div style="font-size:11px;color:var(--dimmer);margin-block-end:5px">${escapeHtml(t('dep.atcPlan'))}</div>
             <div class="raw-wx">${escapeHtml(route.flightplanText)}</div>
           </div>`
        : ''
    }
  `;
}
