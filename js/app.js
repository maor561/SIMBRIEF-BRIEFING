/**
 * Application controller: fetches the OFP, owns chapter routing, and wires the
 * delegated event handlers the views rely on.
 */

import { t, setLang, toggleLang, getLang, applyDocumentLanguage } from './i18n.js';
import { normalizeOfp } from './normalize.js';
import { analyze, countByChapter, SEVERITY } from './analyze.js';
import { escapeHtml, fmtZulu, fmtDuration } from './decode.js';
import { getNotamFilter, notamControls, notamListMarkup } from './ui.js';
import { layoutMasonry } from './masonry.js';

import renderOverview from './views/overview.js';
import renderWeather from './views/weather.js';
import renderNotams from './views/notams.js';
import renderFuel from './views/fuel.js';
import renderPerformance from './views/performance.js';
import renderNavlog from './views/navlog.js';
import { buildFixDetail } from './charts.js';

const STORAGE_USER = 'sbb.username';
const STORAGE_CHAPTER = 'sbb.chapter';

/*
 * Chapters are types of information, not phases of flight -- the way an
 * airline EFB briefing module is organised. `step` is the rail's small
 * ordinal; the cover has none because it is not one of the numbered
 * reference sections.
 */
const CHAPTERS = [
  { id: 'overview', step: '·', render: renderOverview, icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.2 9h17.6M3.2 15h17.6M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18' },
  { id: 'weather', step: '1', render: renderWeather, icon: 'M7.5 18a4.2 4.2 0 0 1-.7-8.34 5.3 5.3 0 0 1 10.2-1.9A4.3 4.3 0 0 1 16.8 18H7.5z' },
  { id: 'notams', step: '2', render: renderNotams, icon: 'M12 3.6 21 19.4H3zM12 9.6v4.3M12 16.7h.01' },
  { id: 'fuel', step: '3', render: renderFuel, icon: 'M5 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16M3 21h13M17 8l2.4 2.4a2 2 0 0 1 .6 1.4V17a1.6 1.6 0 0 0 3.2 0v-6M8 8h3' },
  { id: 'performance', step: '4', render: renderPerformance, icon: 'M3 19h18M4.5 14.5l3.5.6 9.2-8a1.7 1.7 0 0 1 2.4 2.4l-8 9.2.6 3.5-1.8-.6-1.4-3-3-1.4z' },
  { id: 'navlog', step: '5', render: renderNavlog, icon: 'M4 8.5h14l-3.4-3.4M20 15.5H6l3.4 3.4' }
];

const state = {
  raw: null,
  model: null,
  findings: [],
  chapter: localStorage.getItem(STORAGE_CHAPTER) || 'overview',
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

  // The cover carries every finding, so its badge is the whole-flight total
  // rather than a per-chapter count.
  const whole = { total, critical: state.findings.filter((f) => f.severity === SEVERITY.CRITICAL).length };

  el.rail.innerHTML = CHAPTERS.map((chapter) => {
    const count = chapter.id === 'overview' ? whole : counts[chapter.id];
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

function renderChapter({ preserveScroll = false } = {}) {
  const chapter = CHAPTERS.find((c) => c.id === state.chapter) || CHAPTERS[0];
  const scrollTop = preserveScroll ? el.content.scrollTop : 0;
  el.content.innerHTML = chapter.render({ model: state.model, findings: state.findings });
  // Masonry moves card nodes into freshly built row/column wrappers, so it
  // must run on the flat list renderChapter just produced -- calling it
  // again on an already-laid-out tree would nest wrappers instead of
  // rebalancing them. Any change that affects a card's height (like the
  // NOTAM filter below) goes through a full renderChapter, not a DOM patch.
  layoutMasonry(el.content);
  el.content.scrollTop = scrollTop;
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
  if (!username) {
    showError(t('err.emptyUsername'));
    el.username.focus();
    return;
  }
  load({ username });
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

    case 'pane-tab': {
      // Generic sub-page switcher: tabs carry data-show, panes carry
      // data-pane, and the nearest data-pane-group scopes both.
      const group = trigger.closest('[data-pane-group]');
      if (!group) break;
      group.querySelectorAll('[data-action="pane-tab"]').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab === trigger));
      });
      group.querySelectorAll('[data-pane]').forEach((pane) => {
        pane.hidden = pane.dataset.pane !== trigger.dataset.show;
      });
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

    case 'notam-sort': {
      const filter = getNotamFilter(trigger.dataset.icao);
      filter.sort = filter.sort === 'severity' ? 'date' : 'severity';
      refreshNotams(trigger.dataset.icao);
      break;
    }

    case 'notam-expand': {
      const filter = getNotamFilter(trigger.dataset.icao);
      filter.expanded = !filter.expanded;
      refreshNotams(trigger.dataset.icao);
      break;
    }

    // Per-card override; leaves the airport's expand-all state alone.
    case 'notam-full':
      trigger.closest('.notam')?.classList.toggle('expanded');
      break;

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
  refreshNotams(icao);
});

/*
 * Typing filters as you go. The list is swapped in place rather than through
 * renderChapter, because a full re-render would rebuild the input and drop
 * focus mid-word.
 */
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-action="notam-search"]');
  if (!input) return;
  getNotamFilter(input.dataset.icao).search = input.value;
  refreshNotams(input.dataset.icao, { keepFocus: true });
});

/** Rebuilds one airport's NOTAM list from its current filter state. */
function refreshNotams(icao, { keepFocus = false } = {}) {
  const airport = [state.model.origin, state.model.destination, ...state.model.alternates]
    .find((a) => a?.icao === icao);
  const list = document.querySelector(`[data-notam-list][data-icao="${icao}"]`);
  if (!airport || !list) return;

  list.innerHTML = notamListMarkup(airport, flightWindow());

  if (keepFocus) return;
  // The control row reflects sort/expand state, so redraw it too -- except
  // while typing, when replacing the input would steal the caret.
  const bar = list.previousElementSibling;
  if (bar?.classList.contains('notam-toggles')) {
    bar.previousElementSibling?.remove();
    bar.remove();
    list.insertAdjacentHTML('beforebegin', notamControls(icao));
  }
}

function flightWindow() {
  return {
    start: state.model.times.estOut || state.model.times.schedOut,
    end: state.model.times.estIn || state.model.times.schedIn
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

// Rotating the iPad (or resizing a dev window) can cross the two-column
// threshold; re-run the full chapter render so masonry rebalances from a
// flat list rather than re-packing its own already-built row/column tree.
let resizeTimer = null;
addEventListener('resize', () => {
  if (el.app.hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderChapter({ preserveScroll: true }), 150);
});

/* -------------------------------------------------------------------- boot */

/**
 * Surface anything that escapes a handler.
 *
 * Without this an unexpected failure leaves the setup screen sitting there
 * looking idle, which is indistinguishable from a dead button. Better to say
 * what broke than to swallow it.
 */
function reportFatal(source, detail) {
  el.overlay.hidden = false;
  el.app.hidden = true;
  setLoading(false);
  showError(`${t('err.generic')}\n\n${source}: ${detail}`);
}

addEventListener('error', (event) => {
  reportFatal(event.filename ? event.filename.split('/').pop() : 'error', event.message || 'unknown error');
});

addEventListener('unhandledrejection', (event) => {
  reportFatal('async', event.reason?.message || String(event.reason));
});

function applySetupLanguage() {
  applyDocumentLanguage();
  document.getElementById('setup-heading').textContent = t('setup.heading');
  document.getElementById('setup-explain').textContent = t('setup.explain');
  document.getElementById('setup-label').textContent = t('setup.username');
  document.getElementById('setup-hint').textContent = t('setup.hint');
  el.demo.textContent = t('setup.demo');
  el.submit.textContent = t('setup.load');
}

// Tells the inline watchdog in index.html that the module graph loaded.
window.__briefingBooted = true;

applySetupLanguage();

if (state.username) {
  el.username.value = state.username;
  load({ username: state.username });
}
