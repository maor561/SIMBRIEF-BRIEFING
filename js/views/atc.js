/**
 * ATC.
 *
 * The stations this flight will actually talk to, in the order it works
 * through them: delivery to ground to tower to approach at the departure
 * field, the centres along the route, then approach down to ground at the
 * destination. Live staffing comes from the VATSIM datafeed.
 *
 * Below that, the filed ICAO flight plan with a copy button -- the one piece
 * of the briefing a crew regularly needs to paste somewhere else.
 */

import { t } from '../i18n.js';
import { escapeHtml } from '../decode.js';
import { section, icon } from '../ui.js';
import { buildAtcGroups, countOnline, onlineFor } from '../vatsim.js';

/**
 * Rendered synchronously with whatever feed has already arrived; app.js kicks
 * off the fetch and re-renders when it lands. `state` is 'loading', 'ready'
 * or 'error'.
 */
export default function renderAtc({ model, vatsim }) {
  const groups = buildAtcGroups(model, vatsim?.feed || null);
  const online = vatsim?.feed ? countOnline(groups) : 0;

  return `
    <div class="cover">
      ${section(t('atc.stations'), 'headset', stationsBody(model, groups, vatsim), {
        action: feedBadge(vatsim, online)
      })}
      ${section(t('atc.flightPlan'), 'routeSwap', flightPlanBody(model))}
    </div>
  `;
}

function feedBadge(vatsim, online) {
  if (!vatsim || vatsim.state === 'loading') {
    return `<span class="sect-flag"><span class="spinner spinner-sm"></span>${escapeHtml(t('atc.loading'))}</span>`;
  }
  if (vatsim.state === 'error') {
    return `<span class="sect-flag bad">${escapeHtml(t('atc.offline'))}</span>`;
  }
  return `<span class="sect-flag ${online ? 'good' : ''}">${online} ${escapeHtml(t('atc.online'))}</span>`;
}

function stationsBody(model, groups, vatsim) {
  const failed = vatsim?.state === 'error';

  return `
    ${failed ? `<div class="atc-note bad">${escapeHtml(t('atc.feedFailed'))}</div>` : ''}
    ${airportBlock(groups.departure, t('dep.title'))}
    ${enrouteBlock(groups.enroute)}
    ${airportBlock(groups.arrival, t('arr.title'))}
    ${groups.alternates.map((a) => airportBlock(a, t('arr.alternate'))).join('')}
    <div class="atc-note">${escapeHtml(t('atc.noFreqNote'))}</div>
  `;
}

function airportBlock(group, title) {
  if (!group) return '';

  const rows = group.positions
    .map((position) =>
      position.stations.length
        ? position.stations.map((s) => stationRow(t(`atc.pos.${position.key}`), s)).join('')
        : emptyRow(t(`atc.pos.${position.key}`))
    )
    .join('');

  return `<div class="atc-group">
    <div class="atc-group-head">
      <span class="atc-role">${escapeHtml(group.role)}</span>
      <span class="atc-icao ltr">${escapeHtml(group.icao)}</span>
      <span class="atc-title">${escapeHtml(title)}</span>
    </div>
    <div class="atc-rows">${rows}</div>
  </div>`;
}

function enrouteBlock(enroute) {
  if (!enroute.length) return '';

  const rows = enroute
    .map(({ fir, stations }) =>
      stations.length
        ? stations.map((s) => stationRow(fir, s)).join('')
        : emptyRow(fir, t('atc.pos.ctr'))
    )
    .join('');

  return `<div class="atc-group">
    <div class="atc-group-head">
      <span class="atc-role">ENR</span>
      <span class="atc-title">${escapeHtml(t('atc.enroute'))}</span>
    </div>
    <div class="atc-rows">${rows}</div>
  </div>`;
}

function stationRow(label, station) {
  const since = onlineFor(station.logonTime);
  return `<div class="atc-row online">
    <span class="atc-dot"></span>
    <span class="atc-pos">${escapeHtml(label)}</span>
    <span class="atc-callsign ltr">${escapeHtml(station.callsign)}</span>
    <span class="atc-freq ltr">${escapeHtml(station.frequency || '—')}</span>
    <span class="atc-who">
      ${escapeHtml(station.name || '')}
      ${since ? `<i class="ltr">${escapeHtml(since)}</i>` : ''}
    </span>
  </div>`;
}

function emptyRow(label, sublabel) {
  return `<div class="atc-row">
    <span class="atc-dot"></span>
    <span class="atc-pos">${escapeHtml(label)}${sublabel ? ` <em>${escapeHtml(sublabel)}</em>` : ''}</span>
    <span class="atc-callsign"></span>
    <span class="atc-freq">—</span>
    <span class="atc-who muted">${escapeHtml(t('atc.unstaffed'))}</span>
  </div>`;
}

function flightPlanBody(model) {
  const text = model.route.flightplanText;
  if (!text) return `<div class="empty-state">${escapeHtml(t('common.notAvailable'))}</div>`;

  return `
    <div class="atc-fpl">
      <button class="notam-full" data-action="copy-fpl">${icon('info', { size: 13 })}${escapeHtml(t('atc.copy'))}</button>
      <div class="wxrow-text" data-fpl-text>${escapeHtml(text)}</div>
    </div>
  `;
}
