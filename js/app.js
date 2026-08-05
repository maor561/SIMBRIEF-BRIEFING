/**
 * Application controller: fetches the OFP, owns chapter routing, and wires the
 * delegated event handlers the views rely on.
 */

import { t, setLang, toggleLang, getLang, applyDocumentLanguage } from './i18n.js';
import { normalizeOfp } from './normalize.js';
import { analyze, countByChapter, SEVERITY } from './analyze.js';
import { escapeHtml, fmtZulu, fmtDuration } from './decode.js';
import { notamListMarkup, getNotamFilter } from './ui.js';

import renderDeparture from './views/departure.js';
import renderTakeoff from './views/takeoff.js';
import renderCruise, { buildFixDetail } from './views/cruise.js';
import renderDescent from './views/descent.js';
import renderArrival from './views/arrival.js';
import renderSummary from './views/summary.js';

const STORAGE_USER = 'sbb.username';
const STORAGE_CHAPTER = 'sbb.chapter';

const CHAPTERS = [
  { id: 'departure', step: '1', render: renderDeparture, icon: 'M4 20h16M6 20V9l6-4 6 4v11M10 20v-5h4v5' },
  { id: 'takeoff', step: '2', render: renderTakeoff, icon: 'M3 19h18M4.5 14.5l3.5.6 9.2-8a1.7 1.7 0 0 1 2.4 2.4l-8 9.2.6 3.5-1.8-.6-1.4-3-3-1.4z' },
  { id: 'cruise', step: '3', render: renderCruise, icon: 'M2 12h20M6 12l3-5M6 12l3 5M18 9l3 3-3 3' },
  { id: 'descent', step: '4', render: renderDescent, icon: 'M3 5l6 6M3 5v5M3 5h5M21 19H9a5 5 0 0 1-5-5' },
  { id: 'arrival', step: '5', render: renderArrival, icon: 'M3 20h18M5 16l14-2M8 6l3 8M8 6l-2 1 1 6' },
  { id: 'summary', step: '✓', render: renderSummary, icon: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3' }
];

const state = {
  raw: null,
  model: null,
  findings: [],
  chapter: localStorage.getItem(STORAGE_CHAPTER) || 'departure',
  username: localStorage.getItem(STORAGE_USER) || '',
  demo: false,
  loading: false
};

const el = {
  app: document.getElementById('app'),
  overlay: document.getElementById('overlay'),
  header: document.getElementById('header'),
  rail: document.getElementById('rail'),
  content: document.getElementById('content'),
  form: document.getElementById('setup-form'),
  username: document.getElementById('username'),
  submit: document.getElementById('setup-submit'),
  demo: document.getElementById('setup-demo'),
  error: document.getElementById('setup-error')
};

/* ------------------------------------------------------------------ loading */

async function fetchOfp(username) {
  const response = await fetch(`api/ofp?username=${encodeURIComponent(username)}`);
  const payload = await response.json();
  if (!response.ok) {
    const err = new Error(payload.message || 'fetch failed');
    err.code = payload.error;
    throw err;
  }
  return payload;
}

async function fetchDemo() {
  const response = await fetch('test/fixture.json');
  if (!response.ok) throw new Error('demo fixture unavailable');
  return response.json();
}

async function load({ username, demo = false } = {}) {
  setLoading(true);
  showError(null);
  try {
    const raw = demo ? await fetchDemo() : await fetchOfp(username);
    state.raw = raw;
    state.model = normalizeOfp(raw);
    state.findings = analyze(state.model);
    state.demo = demo;

    if (!demo && username) {
      state.username = username;
      localStorage.setItem(STORAGE_USER, username);
    }

    el.overlay.hidden = true;
    el.app.hidden = false;
    render();
  } catch (err) {
    const key = err.code === 'no_ofp' ? 'err.no_ofp' : err.code === 'timeout' ? 'err.timeout' : 'err.generic';
    showError(`${t(key)}${err.message && err.code !== 'no_ofp' ? `\n${err.message}` : ''}`);
    el.overlay.hidden = false;
    el.app.hidden = true;
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  state.loading = on;
  el.submit.disabled = on;
  el.demo.disabled = on;
  el.submit.innerHTML = on ? `<span class="spinner"></span>${escapeHtml(t('setup.loading'))}` : escapeHtml(t('setup.load'));
}

function showError(message) {
  if (!message) {
    el.error.hidden = true;
    el.error.textContent = '';
    return;
  }
  el.error.hidden = false;
  el.error.textContent = message;
}

/* ------------------------------------------------------------------ render */

function render() {
  applyDocumentLanguage();
  renderHeader();
  renderRail();
  renderChapter();
}

function renderHeader() {
  const m = state.model;
  const etd = m.times.estOff || m.times.schedOff;
  const block = m.times.estBlock ?? m.times.schedBlock;
  const altn = m.alternates[0];

  el.header.innerHTML = `
    <span class="callsign">${escapeHtml(m.flight.callsign || '')}</span>
    <span class="pair">${escapeHtml(m.origin?.icao || '')}<span class="arrow">→</span>${escapeHtml(m.destination?.icao || '')}</span>
    <div class="facts">
      <span class="fact"><b>${escapeHtml(m.flight.aircraftIcao || '')}</b><span>${escapeHtml(m.flight.registration || 'TYPE')}</span></span>
      <span class="fact"><b>${escapeHtml(fmtZulu(etd))}</b><span>${escapeHtml(t('header.etd'))}</span></span>
      <span class="fact"><b>${escapeHtml(fmtDuration(block))}</b><span>${escapeHtml(t('header.block'))}</span></span>
      ${altn ? `<span class="fact"><b>${escapeHtml(altn.icao)}</b><span>${escapeHtml(t('header.altn'))}</span></span>` : ''}
    </div>
    <span class="spacer"></span>
    ${state.demo ? `<span class="demo-flag">${escapeHtml(t('header.demo'))}</span>` : ''}
    <div class="tools">
      <span class="clock" id="clock">${escapeHtml(fmtZulu(new Date()))}</span>
      <button class="tool-btn lang" data-action="lang">${getLang() === 'he' ? 'EN' : 'עב'}</button>
      <button class="tool-btn" data-action="refresh" title="${escapeHtml(t('header.refresh'))}">↻</button>
    </div>
  `;
}

function renderRail() {
  const counts = countByChapter(state.findings);
  const total = state.findings.length;

  el.rail.innerHTML = CHAPTERS.map((chapter) => {
    const count = chapter.id === 'summary' ? { total, critical: state.findings.filter((f) => f.severity === SEVERITY.CRITICAL).length } : counts[chapter.id];
    const badge = count?.total
      ? `<span class="rail-badge ${count.critical ? 'critical' : ''}">${count.total}</span>`
      : '';
    return `<button class="rail-item" data-action="chapter" data-chapter="${chapter.id}" aria-current="${chapter.id === state.chapter}">
      ${badge}
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="${chapter.icon}"/></svg>
      <span class="label">${escapeHtml(t(`nav.${chapter.id}`))}</span>
      <span class="step">${escapeHtml(chapter.step)}</span>
    </button>`;
  }).join('');
}

function renderChapter() {
  const chapter = CHAPTERS.find((c) => c.id === state.chapter) || CHAPTERS[0];
  el.content.innerHTML = chapter.render({ model: state.model, findings: state.findings });
  el.content.scrollTop = 0;
  localStorage.setItem(STORAGE_CHAPTER, state.chapter);
}

function goToChapter(id, findingId) {
  if (!CHAPTERS.some((c) => c.id === id)) return;
  state.chapter = id;

  // Move the current marker in place. Rebuilding the rail would detach the
  // button that was just clicked, and the badges have not changed anyway.
  el.rail.querySelectorAll('[data-chapter]').forEach((item) => {
    item.setAttribute('aria-current', String(item.dataset.chapter === id));
  });
  renderChapter();

  if (findingId) {
    const target = el.content.querySelector(`[data-id="${findingId}"]`);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ------------------------------------------------------------------ events */

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const username = el.username.value.trim();
  if (username) load({ username });
});

el.demo.addEventListener('click', () => load({ demo: true }));

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;

  switch (trigger.dataset.action) {
    case 'chapter':
      goToChapter(trigger.dataset.chapter);
      break;

    case 'lang':
      toggleLang();
      render();
      break;

    case 'refresh':
      if (state.demo) load({ demo: true });
      else if (state.username) load({ username: state.username });
      break;

    case 'goto-finding':
      goToChapter(trigger.dataset.chapter, trigger.dataset.id);
      break;

    case 'chart-tab': {
      const group = trigger.closest('[data-chart-group]');
      if (!group) break;
      group.querySelectorAll('[data-action="chart-tab"]').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab === trigger));
      });
      const image = group.querySelector('[data-chart-image]');
      if (image) {
        image.src = trigger.dataset.src;
        image.alt = trigger.textContent.trim();
      }
      break;
    }

    case 'select-fix': {
      const strip = trigger.closest('[data-wx-strip]');
      if (!strip) break;
      strip.querySelectorAll('[data-action="select-fix"]').forEach((hit) => {
        hit.setAttribute('aria-selected', String(hit === trigger));
      });
      const detail = document.querySelector('[data-fix-detail]');
      const fix = state.model.navlog[Number(trigger.dataset.fixIndex)];
      if (detail && fix) detail.innerHTML = buildFixDetail(fix, state.model);
      break;
    }

    default:
      break;
  }
});

document.addEventListener('change', (event) => {
  const input = event.target.closest('[data-action="notam-filter"]');
  if (!input) return;

  const { icao, key } = input.dataset;
  const filter = getNotamFilter(icao);
  filter[key] = input.checked;

  const airport = findAirport(icao);
  const list = document.querySelector(`[data-notam-list][data-icao="${icao}"]`);
  if (airport && list) list.innerHTML = notamListMarkup(airport, flightWindow());
});

function findAirport(icao) {
  const m = state.model;
  return [m.origin, m.destination, ...m.alternates].find((a) => a?.icao === icao) || null;
}

export function flightWindow() {
  const m = state.model;
  return {
    start: m.times.estOut || m.times.schedOut,
    end: m.times.estIn || m.times.schedIn
  };
}

/* Swipe between chapters. Ignores gestures that start on a scrollable chart. */
let touchStart = null;

el.content.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) return;
  if (event.target.closest('.table-scroll, .wx-strip, .ladder')) return;
  touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() };
}, { passive: true });

el.content.addEventListener('touchend', (event) => {
  if (!touchStart) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  const elapsed = Date.now() - touchStart.time;
  touchStart = null;

  if (elapsed > 600 || Math.abs(dx) < 70 || Math.abs(dy) > 50) return;

  const index = CHAPTERS.findIndex((c) => c.id === state.chapter);
  // In RTL a swipe right moves forward through the chapters.
  const forward = getLang() === 'he' ? dx > 0 : dx < 0;
  const next = CHAPTERS[index + (forward ? 1 : -1)];
  if (next) goToChapter(next.id);
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (el.app.hidden) return;
  if (event.target.matches('input, textarea')) return;
  const index = CHAPTERS.findIndex((c) => c.id === state.chapter);
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const forward = getLang() === 'he' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
    const next = CHAPTERS[index + (forward ? 1 : -1)];
    if (next) goToChapter(next.id);
  }
});

setInterval(() => {
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = fmtZulu(new Date());
}, 10000);

/* -------------------------------------------------------------------- boot */

function applySetupLanguage() {
  applyDocumentLanguage();
  document.getElementById('setup-heading').textContent = t('setup.heading');
  document.getElementById('setup-explain').textContent = t('setup.explain');
  document.getElementById('setup-label').textContent = t('setup.username');
  document.getElementById('setup-hint').textContent = t('setup.hint');
  el.demo.textContent = t('setup.demo');
  el.submit.textContent = t('setup.load');
}

applySetupLanguage();

if (state.username) {
  el.username.value = state.username;
  load({ username: state.username });
}
