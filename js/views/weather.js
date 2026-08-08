/**
 * Weather.
 *
 * Every weather product the OFP carries, grouped by where it applies:
 * each field in turn, then what happens between them.
 */

import { t } from '../i18n.js';
import { escapeHtml } from '../decode.js';
import { section, metarBlock, tafBlock, chip, categoryDot } from '../ui.js';
import { weatherStrip, buildFixDetail, defaultFix, chartsBody } from '../charts.js';

export default function renderWeather({ model }) {
  const eta = model.times.estOn || model.times.schedOn;
  const etd = model.times.estOff || model.times.schedOff;

  const fields = [
    { airport: model.origin, role: t('nav.departure'), reference: etd },
    { airport: model.destination, role: t('nav.arrival'), reference: eta },
    ...model.alternates.map((a) => ({ airport: a, role: t('arr.alternate'), reference: eta }))
  ].filter((f) => f.airport);

  return `
    <div class="cover">
      ${fields.map(airportSection).join('')}
      ${section(t('wx.sigmet'), 'airspace', sigmetBody(model), { action: sigmetBadge(model) })}
      ${section(t('crz.wxStrip'), 'wind', routeWeatherBody(model))}
      ${section(t('crz.charts'), 'visibility', chartsBody(model))}
    </div>
  `;
}

function airportSection({ airport, role, reference }) {
  const title = `${role} — ${airport.icao}`;
  const badge = airport.metarCategory
    ? `<span class="sect-flag"><span class="cat-dot cat-${airport.metarCategory}"></span>${escapeHtml(airport.metarCategory.toUpperCase())}</span>`
    : '';

  const atis = airport.atis?.length ? airport.atis[airport.atis.length - 1] : null;

  return section(title, 'ceiling', `
    <div class="sect-pad">${metarBlock(airport)}</div>
    <div class="sect-split">
      <div>
        <div class="sect-label">${escapeHtml(t('wx.taf'))}</div>
        ${tafBlock(airport, reference)}
      </div>
      ${
        atis
          ? `<div>
               <div class="sect-label">${escapeHtml(t('wx.atis'))}${atis.letter ? ` — ${escapeHtml(atis.letter)}` : ''}</div>
               <div class="raw-wx">${escapeHtml(atis.text)}</div>
             </div>`
          : ''
      }
    </div>
  `, { action: badge });
}

function sigmetBadge(model) {
  const count = model.sigmets?.length || 0;
  return count
    ? `<span class="sect-flag warn">${count}</span>`
    : `<span class="sect-flag good">0</span>`;
}

function sigmetBody(model) {
  const items = model.sigmets || [];
  if (!items.length) {
    return `<div class="empty-state good">${escapeHtml(t('wx.sigmetEmpty'))}</div>`;
  }
  return `<div class="sect-pad">${items
    .map(
      (s) => `<div style="margin-block-end:11px">
        ${s.fir ? chip(s.fir, 'blue') : ''}
        <div class="raw-wx" style="margin-block-start:6px">${escapeHtml(s.text)}</div>
      </div>`
    )
    .join('')}</div>`;
}

function routeWeatherBody(model) {
  return `
    <div class="img-note" style="padding:11px 15px 0">${escapeHtml(t('crz.wxStripHint'))}</div>
    ${weatherStrip(model)}
    <div class="sect-pad"><div data-fix-detail>${buildFixDetail(defaultFix(model), model)}</div></div>
  `;
}
