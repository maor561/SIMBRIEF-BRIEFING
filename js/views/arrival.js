/**
 * Chapter 5 — Arrival airport.
 *
 * The alternate card stays fully expanded rather than collapsed: by the time it
 * matters the crew is already busy, and hunting for it is exactly the wrong
 * workload at that moment.
 */

import { t } from '../i18n.js';
import { escapeHtml, fmtNumber, fmtFeet, fmtWeight, fmtDuration, fmtZulu } from '../decode.js';
import {
  card,
  flushCard,
  collapsible,
  tiles,
  chip,
  icon,
  categoryDot,
  runwayTable,
  chapterHeading,
  chapterFindings,
  airportIdentity,
  metarBlock,
  tafBlock,
  atisBlock,
  notamCard,
  notamListMarkup,
  landingPerformanceBody
} from '../ui.js';
import { notamSeverity, categoryClass } from '../decode.js';

export default function renderArrival({ model, findings }) {
  const airport = model.destination;
  if (!airport) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  const eta = model.times.estOn || model.times.schedOn;
  const window = {
    start: model.times.estOut || model.times.schedOut,
    end: model.times.estIn || model.times.schedIn
  };

  return `
    ${chapterHeading(`${airport.icao} · ${airport.name || ''}`, t('arr.title'), categoryDot(airport.metarCategory))}

    <div class="grid">
      <div class="col-12">${flushCard({ headless: true, body: airportIdentity(airport) })}</div>

      ${findings.some((f) => f.chapter === 'arrival') ? `<div class="col-12">${chapterFindings(findings, 'arrival')}</div>` : ''}

      <div class="col-7">
        ${flushCard({ title: t('arr.landingPerf'), body: landingPerformanceBody(model) })}
      </div>

      <div class="col-5">
        ${card({ title: t('wx.metar'), body: metarBlock(airport) })}
      </div>

      <div class="col-5">
        ${flushCard({ title: t('wx.taf'), body: tafBlock(airport, eta) })}
      </div>

      <div class="col-7">
        ${notamCard(airport, window)}
      </div>

      <div class="col-12">${atisBlock(airport)}</div>

      ${model.alternates
        .map((alternate) => `<div class="col-12">${alternateCard(model, alternate, window)}</div>`)
        .join('')}

      <div class="col-12">
        ${collapsible({ title: t('to.otherRunways'), body: runwayTable(model.tlr.landing, { landing: true }) })}
      </div>
    </div>
  `;
}

/**
 * The alternate, in full: how far, how long, how much fuel, and its own
 * weather and NOTAMs.
 */
function alternateCard(model, alternate, window) {
  const criticalNotams = alternate.notams.filter((n) => notamSeverity(n, alternate.plannedRunway) === 3).length;

  const body = `
    ${tiles([
      { label: t('arr.altnDistance'), value: fmtNumber(alternate.distance), unit: 'nm', size: 'big' },
      { label: t('arr.altnEte'), value: fmtDuration(alternate.ete), size: 'big' },
      { label: t('arr.altnBurn'), value: fmtNumber(alternate.burn), unit: model.units === 'lbs' ? 'lb' : 'kg', size: 'big' },
      { label: t('arr.altnCruise'), value: alternate.cruiseAltitude ? `FL${Math.round(alternate.cruiseAltitude / 100)}` : '—' },
      { label: t('common.runway'), value: escapeHtml(alternate.plannedRunway || '—') },
      { label: t('common.elevation'), value: fmtFeet(alternate.elevation) }
    ])}

    <div class="grid" style="padding:13px">
      <div class="col-6">${card({ title: t('wx.metar'), body: metarBlock(alternate) })}</div>
      <div class="col-6">${flushCard({ title: t('wx.taf'), body: tafBlock(alternate, model.times.estOn) })}</div>
      <div class="col-12">
        ${flushCard({
          title: `${t('notam.title')} — ${alternate.icao}`,
          badge: `${criticalNotams ? chip(`${criticalNotams} ${t('sev.critical')}`, 'red') : ''}${chip(`${alternate.notams.length}`)}`,
          body: `<div data-notam-list data-icao="${alternate.icao}">${notamListMarkup(alternate, window)}</div>`
        })}
      </div>
      ${
        alternate.route
          ? `<div class="col-12">
               <div style="font-size:11px;color:var(--dimmer);margin-block-end:5px">${escapeHtml(t('arr.altnRoute'))}</div>
               <div class="raw-wx">${escapeHtml(alternate.route)}</div>
             </div>`
          : ''
      }
    </div>
  `;

  return flushCard({
    title: `${t('arr.alternate')} — ${alternate.icao} · ${alternate.name || ''}`,
    hint: t('arr.alternateHint'),
    badge: alternate.metarCategory
      ? `<span class="chip ${categoryClass(alternate.metarCategory)}">${categoryDot(alternate.metarCategory)}${escapeHtml(alternate.metarCategory.toUpperCase())}</span>`
      : '',
    body,
    cls: 'accent-amber'
  });
}
