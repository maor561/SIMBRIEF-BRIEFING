/**
 * Application controller: fetches the OFP, owns chapter routing, and wires the
 * delegated event handlers the views rely on.
 */

import { t } from './i18n.js';
import { normalizeOfp } from './normalize.js';
import { analyze, countByChapter, SEVERITY } from './analyze.js';
import { escapeHtml, fmtZulu, fmtDuration, fmtNumber, fmtLocal } from './decode.js';
import { getNotamFilter, notamControls, notamListMarkup } from './ui.js';
import { layoutMasonry } from './masonry.js';

import renderOverview, { positionAircraft, tickCountdown } from './views/overview.js';
import renderWeather from './views/weather.js';
import renderNotams from './views/notams.js';
import renderFuel from './views/fuel.js';
import renderPerformance from './views/performance.js';
import renderNavlog, { diffCell, summaryPanel, summaryFlag } from './views/navlog.js';
import renderReport from './views/report.js';
import renderAtc from './views/atc.js';
import { buildFixDetail } from './charts.js';
import { setActual, classify, clearActuals, getActuals } from './fuellog.js';
import { markRead, markUnread } from './notamlog.js';
import { decodeToken } from './glossary.js';
import {
  getTimeline,
  stampPhase,
  clearPhase,
  resetTimeline,
  phaseElapsed,
  dueCheckpoint,
  setPromptMode,
  dueAlert,
  markAlertSeen,
  actualOff
} from './timeline.js';

const STORAGE_USER = 'sbb.username';

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
  { id: 'atc', step: '5', render: renderAtc, icon: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 0 2 2h1.2v-5.4H6a2 2 0 0 0-2 2zM20 15a2 2 0 0 1-2 2h-1.2v-5.4H18a2 2 0 0 1 2 2zM19 17.6v.6a2.6 2.6 0 0 1-2.6 2.6H13' },
  { id: 'navlog', step: '6', render: renderNavlog, icon: 'M4 8.5h14l-3.4-3.4M20 15.5H6l3.4 3.4' },
  { id: 'report', step: '7', render: renderReport, icon: 'M6.5 3h7.6L19 7.9V21H6.5zM14 3v5h5M9.5 13h6M9.5 16.5h4' }
];

/**
 * Every live pull revalidates with the server rather than trusting the
 * browser's copy. The API responses carry `stale-while-revalidate`, which lets
 * the private cache hand back a minutes-old body without asking -- fine for a
 * CDN, wrong for a crew who just pressed refresh and expects current weather.
 * The `s-maxage` on those responses still keeps the shared cache in front of
 * SimBrief and VATSIM, so this costs a round trip, not upstream load.
 */
const LIVE_FETCH = { cache: 'no-cache' };

const state = {
  raw: null,
  model: null,
  findings: [],
  chapter: 'overview',
  username: localStorage.getItem(STORAGE_USER) || '',
  demo: false,
  loading: false,
  // Live VATSIM staffing: { state: 'loading' | 'ready' | 'error', feed }.
  vatsim: null,
  // Live METAR from VATSIM, keyed by ICAO. The OFP snapshot stays the
  // baseline so the screen still works with no network.
  liveMetar: null,
  // Turnaround phases and the real wheels-up time, once the crew marks it.
  timeline: { phases: {}, current: null },
  // When the OFP-refresh check last ran, and the generatedAt of a newer OFP
  // once seen -- the latter remembered so dismissing it does not just bring
  // it back on the next sweep.
  ofpCheckedAt: 0,
  ofpUpdate: null,
  ofpDismissed: null,
  checkingOfp: false,
  // Which runway the Performance chapter is briefing, when it is not the
  // planned one. Held here rather than in the view because a chapter switch
  // rebuilds the view entirely, and a runway change survives that.
  runwayPick: { takeoff: null, landing: null }
};

const el = {
  app: document.getElementById('app'),
  overlay: document.getElementById('overlay'),
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
  const response = await fetch(`api/ofp?username=${encodeURIComponent(username)}`, LIVE_FETCH);
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
    state.timeline = getTimeline(state.model);
    state.demo = demo;

    if (!demo && username) {
      state.username = username;
      localStorage.setItem(STORAGE_USER, username);
    }

    // Every freshly loaded briefing opens on its cover, whichever chapter the
    // last session happened to end on.
    state.chapter = 'overview';
    state.vatsim = null;
    state.liveMetar = null;
    // A new plan brings its own planned runways; carrying the old pick over
    // would brief a runway this OFP never chose.
    state.runwayPick = { takeoff: null, landing: null };

    // Whatever this load just fetched is by definition the newest copy, so
    // any pending "new OFP" notice from before is stale news now.
    state.ofpCheckedAt = Date.now();
    state.ofpUpdate = null;
    state.ofpDismissed = null;
    updateOfpAlert();

    el.overlay.hidden = true;
    el.app.hidden = false;
    render();
    // Opening the app mid-flight with a reading already owed should ask at
    // once, rather than on whichever second the freshness tick next lands.
    updateFuelPrompt();
    keepAwake();
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
  renderRail();
  renderChapter();
}

function renderRail() {
  const counts = countByChapter(state.findings);
  const total = state.findings.length;

  // The cover carries every finding, so its badge is the whole-flight total
  // rather than a per-chapter count.
  const whole = { total, critical: state.findings.filter((f) => f.severity === SEVERITY.CRITICAL).length };

  const items = CHAPTERS.map((chapter) => {
    const count = chapter.id === 'overview' ? whole : counts[chapter.id];
    const badge = count?.total
      ? `<span class="rail-badge ${count.critical ? 'critical' : ''}">${count.total}</span>`
      : '';
    return `<button class="rail-item" data-action="chapter" data-chapter="${chapter.id}" aria-current="${chapter.id === state.chapter}">
      ${badge}
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="${chapter.icon}"/></svg>
      <span class="label">${escapeHtml(t(`nav.${chapter.id}`))}</span>
    </button>`;
  }).join('');

  // Refresh and the Zulu clock are app-level, not part of any one chapter, so
  // they sit at the foot of the rail rather than in a bar of their own. The
  // demo marker stays with them: it has to remain visible on every screen so
  // sample data is never mistaken for a real briefing.
  el.rail.innerHTML = `
    <div class="rail-items">${items}</div>
    <div class="rail-foot">
      ${state.demo ? `<span class="demo-flag">${escapeHtml(t('header.demo'))}</span>` : ''}
      <span class="clock" id="clock">${escapeHtml(fmtZulu(new Date()))}</span>
      ${alertsButton()}
      ${installButton()}
      <button class="rail-btn" data-action="open-manual" title="${escapeHtml(t('manual.open'))}" aria-label="${escapeHtml(t('manual.open'))}">
        <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/></svg>
      </button>
      <button class="rail-btn" data-action="refresh" title="${escapeHtml(t('header.refresh'))}" aria-label="${escapeHtml(t('header.refresh'))}">
        <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4"/></svg>
      </button>
    </div>
  `;
}

/**
 * Offered while there is something to grant, hidden once granted -- and, if
 * the crew denied it, swapped for a muted state rather than disappearing.
 *
 * A denied bell used to just vanish, with nothing left in the rail to say
 * why or how to undo it. `Notification.requestPermission()` cannot be asked
 * again once denied -- the browser answers 'denied' without even showing a
 * prompt -- so the fix is not a retry, it is telling the crew where to look:
 * the site's own settings in the browser, not this app.
 */
function alertsButton() {
  if (!('Notification' in window)) return '';
  if (Notification.permission === 'granted') return '';

  if (Notification.permission === 'denied') {
    const label = escapeHtml(t('alert.blockedTitle'));
    return `<button class="rail-btn muted" data-action="alerts-blocked" title="${label}" aria-label="${label}">
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 15v-4a6 6 0 1 0-12 0v4l-1.6 2.4h15.2zM10 20h4M4 4l16 16"/></svg>
    </button>`;
  }

  const label = escapeHtml(t('alert.enable'));
  return `<button class="rail-btn" data-action="enable-alerts" title="${label}" aria-label="${label}">
    <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 15v-4a6 6 0 1 0-12 0v4l-1.6 2.4h15.2zM10 20h4"/></svg>
  </button>`;
}

/** Hidden once the app is installed, or where installing is not on offer. */
function installButton() {
  const state = installState();
  if (state === 'installed' || state === 'unavailable') return '';
  const label = escapeHtml(t('install.add'));
  return `<button class="rail-btn" data-action="install-app" title="${label}" aria-label="${label}">
    <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>
  </button>`;
}

function renderChapter({ preserveScroll = false } = {}) {
  const chapter = CHAPTERS.find((c) => c.id === state.chapter) || CHAPTERS[0];
  const scrollTop = preserveScroll ? el.content.scrollTop : 0;
  el.content.innerHTML = chapter.render({
    model: state.model,
    findings: state.findings,
    vatsim: state.vatsim,
    liveMetar: state.liveMetar,
    timeline: state.timeline,
    runwayPick: state.runwayPick
  });
  if (chapter.id === 'atc') ensureVatsim();
  // Performance wants it too: the live wind is what its takeoff figures get
  // compared against.
  // Overview needs it too, now that the divert panel shows the alternate's
  // live wind alongside the fuel arithmetic.
  if (chapter.id === 'weather' || chapter.id === 'performance' || chapter.id === 'overview') {
    ensureLiveMetar();
  }
  // Masonry moves card nodes into freshly built row/column wrappers, so it
  // must run on the flat list renderChapter just produced -- calling it
  // again on an already-laid-out tree would nest wrappers instead of
  // rebalancing them. Any change that affects a card's height (like the
  // NOTAM filter below) goes through a full renderChapter, not a DOM patch.
  layoutMasonry(el.content);
  // Filled straight away rather than on the next tick, so it never paints
  // blank for a second when the chapter opens.
  if (chapter.id === 'overview') tickCountdown(state.model, state.timeline, el.content);
  el.content.scrollTop = scrollTop;
}

/** Finds one of the plan's airports by code, for actions that name one. */
function airportByIcao(icao) {
  if (!icao || !state.model) return null;
  return (
    [state.model.origin, state.model.destination, ...state.model.alternates].find(
      (a) => a?.icao === icao
    ) || null
  );
}

/* ------------------------------------------------------------- freshness */

/**
 * Keeps the live feeds from going stale on a tablet left on the stand.
 *
 * Deliberately age-based rather than a 30-minute interval: an interval stops
 * firing while the device sleeps and comes back believing it is on schedule.
 * Sweeping every minute and asking how old each feed actually is means waking
 * from an hour asleep refreshes at once, which is exactly when the weather on
 * screen is least likely to still be true.
 *
 * Only feeds already pulled once are refreshed. Never opening ATC should not
 * start polling VATSIM in the background.
 */
const LIVE_MAX_AGE_MS = 30 * 60 * 1000;
const FRESHNESS_TICK_MS = 60 * 1000;

function isStale(feed) {
  if (!feed || feed.state === 'loading') return false;
  const at = new Date(feed.fetchedAt ?? 0).getTime();
  return !Number.isFinite(at) || Date.now() - at >= LIVE_MAX_AGE_MS;
}

function refreshStaleFeeds() {
  // Nothing to refresh before a briefing is loaded, and no point spending a
  // request on a screen nobody is looking at.
  if (!state.model || document.hidden) return;

  if (isStale(state.liveMetar)) {
    state.liveMetar = null;
    ensureLiveMetar();
  }
  if (isStale(state.vatsim)) {
    state.vatsim = null;
    ensureVatsim();
  }
}

setInterval(() => {
  refreshStaleFeeds();
  // A lock refused earlier -- before the first tap, or by a device that was
  // busy at the time -- is worth asking for again while the briefing is up.
  keepAwake();
  checkForNewOfp();
}, FRESHNESS_TICK_MS);
// Coming back to the tab is the moment the figures are about to be read, so
// the age check runs then too rather than waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshStaleFeeds();
  // The wake lock does not survive being hidden, so it is taken again here.
  keepAwake();
  checkForNewOfp();
});

/* --------------------------------------------------------------- ofp update */

const OFP_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Polls for a newer OFP than the one loaded, so a dispatcher's revision does
 * not go unnoticed until the crew happens to hit refresh themselves.
 *
 * Skipped once wheels-up is stamped: from there this app has no way to act
 * on a re-dispatch anyway, and the banner would just be noise during a busy
 * phase. Skipped for the demo, which never changes, and while a check is
 * already in flight or the last one is still recent -- this rides the same
 * sweep as the live-feed freshness check, so it needs its own throttle.
 */
async function checkForNewOfp() {
  if (state.demo || !state.username || !state.model || document.hidden) return;
  if (state.checkingOfp || actualOff(state.timeline)) return;
  if (Date.now() - state.ofpCheckedAt < OFP_CHECK_INTERVAL_MS) return;

  state.checkingOfp = true;
  try {
    const raw = await fetchOfp(state.username);
    const generated = Number(raw?.params?.time_generated) * 1000;
    state.ofpCheckedAt = Date.now();

    if (
      Number.isFinite(generated) &&
      generated > 0 &&
      generated !== state.model.generatedAt?.getTime() &&
      generated !== state.ofpDismissed
    ) {
      state.ofpUpdate = generated;
      updateOfpAlert();
    }
  } catch {
    // A failed background check is not worth surfacing -- the crew has not
    // asked for anything, so there is nothing to apologise for. The next
    // sweep tries again.
  } finally {
    state.checkingOfp = false;
  }
}

function updateOfpAlert() {
  const node = document.getElementById('ofp-alert');
  if (!node) return;

  if (!state.ofpUpdate) {
    node.hidden = true;
    node.innerHTML = '';
    return;
  }

  node.hidden = false;
  node.innerHTML = `<div class="alert-card">
    <button class="alert-key ofp-reload-btn" type="button" data-action="ofp-reload">
      ${escapeHtml(t('ofp.updated'))}
      <b class="ltr">${escapeHtml(t('ofp.reload'))}</b>
    </button>
    <button class="alert-close" data-action="ofp-dismiss" aria-label="${escapeHtml(t('common.close'))}">✕</button>
  </div>`;
}

/** Briefly swaps a button's label to confirm what just happened. */
function flash(button, message) {
  const original = button.innerHTML;
  button.textContent = message;
  setTimeout(() => {
    button.innerHTML = original;
  }, 1600);
}

/**
 * Fetches VATSIM staffing the first time the ATC chapter is opened, then
 * re-renders once it lands. The guard on `state.chapter` matters: the fetch
 * takes a moment and the reader may have moved on by the time it resolves,
 * in which case repainting would yank them back.
 */
async function ensureVatsim() {
  if (state.vatsim) return;
  state.vatsim = { state: 'loading', feed: null };

  try {
    const response = await fetch('api/vatsim', LIVE_FETCH);
    if (!response.ok) throw new Error(`vatsim ${response.status}`);
    state.vatsim = { state: 'ready', feed: await response.json(), fetchedAt: Date.now() };
  } catch {
    state.vatsim = { state: 'error', feed: null, fetchedAt: Date.now() };
  }

  if (state.chapter === 'atc') renderChapter({ preserveScroll: true });
}

/**
 * Pulls the current METAR for every field on the plan. Same guard as the
 * VATSIM fetch: the reader may have moved on before it lands, and repainting
 * a chapter they left would yank them back.
 */
async function ensureLiveMetar() {
  if (state.liveMetar) return;

  const ids = [state.model.origin, state.model.destination, ...state.model.alternates]
    .filter(Boolean)
    .map((a) => a.icao)
    .filter(Boolean);
  if (!ids.length) return;

  state.liveMetar = { state: 'loading', metars: {} };

  try {
    const response = await fetch(`api/metar?ids=${encodeURIComponent(ids.join(','))}`, LIVE_FETCH);
    if (!response.ok) throw new Error(`metar ${response.status}`);
    const payload = await response.json();
    state.liveMetar = { state: 'ready', metars: payload.metars || {}, fetchedAt: payload.fetchedAt };
  } catch {
    // Stamped even on failure, so the retry waits a full cycle instead of the
    // freshness sweep hammering an endpoint that is plainly down.
    state.liveMetar = { state: 'error', metars: {}, fetchedAt: new Date().toISOString() };
  }

  // The live observation feeds the exception engine as well as the screens,
  // so the findings and their nav badges are rebuilt with it.
  state.findings = analyze(state.model, state.liveMetar);
  renderRail();

  if (state.chapter === 'weather' || state.chapter === 'performance' || state.chapter === 'overview') {
    renderChapter({ preserveScroll: true });
  }
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

/*
 * Enter and Space on anything that is a button by role but not by tag.
 *
 * Glossary tokens and runway rows both carry `role="button" tabindex="0"`
 * precisely so this works: a keyboard-only reader can reach one and activate
 * it the way any other button activates. A real <button> is left alone --
 * the browser already turns those keys into a click, and handling them here
 * too would fire the action twice.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;

  const token = event.target.closest('[data-gloss]');
  if (token) {
    // Space would otherwise scroll the page under a focused, non-form element.
    event.preventDefault();
    toggleGlossary(token);
    return;
  }

  const target = event.target.closest('[data-action][role="button"]');
  if (!target || target.tagName === 'BUTTON') return;

  event.preventDefault();
  target.click();
});

document.addEventListener('click', (event) => {
  // A METAR/TAF/NOTAM token that decodes. Handled before anything else, and
  // it swallows the click entirely -- a tap that opens the glossary should
  // not also register as a tap on whatever the token happens to sit inside.
  const token = event.target.closest('[data-gloss]');
  if (token) {
    toggleGlossary(token);
    return;
  }
  // Any other tap closes an open glossary popover, including a tap on a rail
  // item or another control -- it should not go on floating over content the
  // reader has since moved past.
  if (!event.target.closest('#glossary')) closeGlossary();

  // Tapping the dimmed area around the prompt puts it off, the way any
  // centred dialog behaves.
  if (event.target.id === 'fuel-prompt') {
    dismissedPrompts.add(event.target.dataset.fixIndex);
    updateFuelPrompt();
    return;
  }

  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;

  switch (trigger.dataset.action) {
    case 'chapter':
      goToChapter(trigger.dataset.chapter);
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

    // Reading through an airport's NOTAMs and saying so is what makes the
    // next pass useful -- whatever is still flagged is what arrived since.
    case 'notams-read':
    case 'notams-unread': {
      const airport = airportByIcao(trigger.dataset.icao);
      if (!airport) break;
      if (trigger.dataset.action === 'notams-read') markRead(airport.notams);
      else markUnread(airport.notams);
      renderChapter({ preserveScroll: true });
      break;
    }

    // Stamping takeoff re-anchors every time in the briefing, so the whole
    // chapter is rebuilt rather than patched -- the navlog, the fuel checks
    // and the schedule all move with it.
    case 'phase-stamp': {
      const phase = trigger.dataset.phase;
      state.timeline = stampPhase(state.model, phase);
      updateFuelPrompt();
      // Touchdown is what the report was waiting for, so it opens itself
      // rather than leaving the crew to go looking for it.
      if (phase === 'landing') goToChapter('report');
      else renderChapter({ preserveScroll: true });
      break;
    }

    case 'phase-clear':
      state.timeline = clearPhase(state.model, trigger.dataset.phase);
      updateFuelPrompt();
      renderChapter({ preserveScroll: true });
      break;

    case 'timeline-reset':
      state.timeline = resetTimeline(state.model);
      updateFuelPrompt();
      renderChapter({ preserveScroll: true });
      break;

    // The prompt writes into the same fuel log the navlog table does, so a
    // reading taken here shows up there and on the fuel curve.
    case 'prompt-save': {
      const input = document.querySelector('[data-action="prompt-fuel"]');
      const index = Number(input?.dataset.fixIndex);
      const digits = (input?.value || '').replace(/\D/g, '');
      if (digits) setActual(state.model, index, digits);
      dismissedPrompts.add(String(index));
      updateFuelPrompt();
      if (state.chapter === 'navlog' || state.chapter === 'fuel') {
        renderChapter({ preserveScroll: true });
      }
      break;
    }

    // Switching cadence re-opens anything the new setting says is owed, so
    // turning on every-fix mid-flight does not wait for the next one.
    case 'prompt-mode':
      setPromptMode(trigger.dataset.mode);
      dismissedPrompts.clear();
      updateFuelPrompt();
      renderChapter({ preserveScroll: true });
      break;

    case 'prompt-skip': {
      const node = document.getElementById('fuel-prompt');
      if (node?.dataset.fixIndex) dismissedPrompts.add(node.dataset.fixIndex);
      updateFuelPrompt();
      break;
    }

    case 'alert-dismiss': {
      const node = document.getElementById('alert');
      if (node?.dataset.key) state.timeline = markAlertSeen(state.model, node.dataset.key);
      node.hidden = true;
      node.innerHTML = '';
      delete node.dataset.key;
      break;
    }

    // An empty data-runway is the reset control on the switch banner, which
    // clears the pick and falls the section back to the planned runway.
    case 'pick-runway': {
      const { role, runway } = trigger.dataset;
      if (role !== 'takeoff' && role !== 'landing') break;
      state.runwayPick = { ...state.runwayPick, [role]: runway || null };
      renderChapter({ preserveScroll: true });
      break;
    }

    case 'ofp-reload':
      load({ username: state.username });
      break;

    // Remembers this particular OFP's generatedAt so the same revision does
    // not reappear on the next sweep -- a genuinely newer one still will.
    case 'ofp-dismiss':
      state.ofpDismissed = state.ofpUpdate;
      state.ofpUpdate = null;
      updateOfpAlert();
      break;

    case 'glossary-close':
      closeGlossary();
      break;

    // Turning alerts on has to happen inside a tap: browsers refuse a
    // permission request that did not come from one.
    case 'enable-alerts':
      requestAlerts(trigger);
      break;

    // Nothing left to ask the browser -- it will not re-prompt once denied
    // -- so this just points at where the switch actually lives now.
    case 'alerts-blocked':
      flash(trigger, t('alert.blockedFlash'));
      break;

    case 'install-app':
      runInstall(trigger);
      break;

    // A new tab, not a chapter switch: the manual is reference material read
    // beside the briefing, not a screen inside it, and a crew mid-flight
    // should never lose their place in the briefing to open it.
    case 'open-manual':
      window.open('manual.html', '_blank', 'noopener');
      break;

    case 'clear-fuel-log':
      clearActuals(state.model);
      renderChapter({ preserveScroll: true });
      break;

    // Controllers come and go, so the feed is worth re-pulling on demand
    // rather than only on first open.
    case 'refresh-vatsim':
      state.vatsim = null;
      renderChapter({ preserveScroll: true });
      break;

    case 'refresh-metar':
      state.liveMetar = null;
      renderChapter({ preserveScroll: true });
      break;

    case 'copy-fpl': {
      const text = document.querySelector('[data-fpl-text]')?.textContent || '';
      navigator.clipboard?.writeText(text).then(
        () => flash(trigger, t('atc.copied')),
        () => flash(trigger, t('atc.copyFailed'))
      );
      break;
    }

    default:
      break;
  }
});

/**
 * Fuel readings repaint in place rather than through renderChapter: a full
 * re-render would replace the input the crew is typing into and drop focus
 * mid-figure.
 */
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-action="actual-fuel"]');
  if (!input) return;

  // The field is type="text" to get the plain numeric keypad on iOS, so it
  // has to reject anything that is not a digit itself.
  const digits = input.value.replace(/\D/g, '');
  if (digits !== input.value) input.value = digits;

  const index = Number(input.dataset.fixIndex);
  const actuals = setActual(state.model, index, digits);
  const fix = state.model.navlog.find((f) => f.index === index);

  const cell = document.querySelector(`[data-fuel-diff="${index}"]`);
  if (cell && fix) {
    const { state: verdict, diff } = classify(fix, actuals[index], state.model.fuel.contingency, state.model.fuel.planRamp);
    cell.innerHTML = diffCell(verdict, diff);
  }

  const summary = document.querySelector('[data-fuel-summary]');
  if (summary) summary.innerHTML = summaryPanel(state.model, actuals);

  const flag = document.querySelector('[data-fuel-flag]');
  if (flag) flag.innerHTML = summaryFlag(state.model, actuals);
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
  const forward = dx < 0;
  const next = CHAPTERS[index + (forward ? 1 : -1)];
  if (next) goToChapter(next.id);
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (el.app.hidden) return;

  if (event.key === 'Escape') {
    const glossary = document.getElementById('glossary');
    if (glossary && !glossary.hidden) {
      closeGlossary();
      event.preventDefault();
      return;
    }
  }

  // The prompt is centred and dimmed behind, so it has to be dismissible from
  // the keyboard as well as by tapping -- a modal with no way out is the one
  // thing it must never become. Enter logs, Escape puts it off.
  const prompt = document.getElementById('fuel-prompt');
  if (prompt && !prompt.hidden) {
    if (event.key === 'Escape') {
      dismissedPrompts.add(prompt.dataset.fixIndex);
      updateFuelPrompt();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      prompt.querySelector('[data-action="prompt-save"]')?.click();
      event.preventDefault();
      return;
    }
  }

  if (event.target.matches('input, textarea')) return;
  const index = CHAPTERS.findIndex((c) => c.id === state.chapter);
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const forward = event.key === 'ArrowRight';
    const next = CHAPTERS[index + (forward ? 1 : -1)];
    if (next) goToChapter(next.id);
  }
});

setInterval(() => {
  const clock = document.getElementById('clock');
  if (clock) clock.textContent = fmtZulu(new Date());

  // Each field's own clock beside its name, ticking off the offset baked
  // into the mark rather than anything re-render would have to recompute.
  const now = new Date();
  for (const node of document.querySelectorAll('[data-port-clock]')) {
    node.textContent = fmtLocal(now, Number(node.dataset.portClock));
  }
}, 10000);

/*
 * A running phase's timer is patched in place every second rather than
 * re-rendering the chapter: a full render would rebuild the DOM under the
 * crew's finger once a second, and the only thing that changed is a duration.
 */
setInterval(() => {
  if (!state.model || document.hidden) return;

  for (const node of document.querySelectorAll('[data-phase-clock]')) {
    const seconds = phaseElapsed(state.timeline, node.dataset.phaseClock);
    if (seconds !== null) node.textContent = fmtDuration(seconds);
  }

  // The aircraft on the schedule curve moves the same way: two custom
  // properties, no re-render. The countdown to takeoff repaints with it.
  positionAircraft(state.model, state.timeline);
  tickCountdown(state.model, state.timeline);
}, 1000);

/* ---------------------------------------------------------- fuel prompt */

/**
 * Asks for the fuel on board when a logging point comes due.
 *
 * The points come from the plan (top of climb, each hour of cruise, top of
 * descent, destination) but the moment comes from the real clock, which only
 * exists once takeoff has been stamped. Dismissing one puts it aside for this
 * session rather than for good -- a reading skipped in a busy descent is
 * still worth having ten minutes later.
 */
const dismissedPrompts = new Set();

/*
 * The two-tone cabin chime, synthesised rather than loaded.
 *
 * A sound file would be one more thing to fetch, cache and have go missing
 * offline -- which is exactly the situation this app is built for. Two sine
 * tones with a soft envelope cost nothing and always work.
 *
 * The context is opened on the first tap or keypress rather than when a chime
 * is wanted. A browser refuses to start audio until the page has been
 * interacted with, and the prompt is raised by a timer, not by a tap -- so
 * building the context at that moment is guaranteed to be refused and to log
 * a warning for every tone. Opening it on a gesture the crew was making
 * anyway means it is already running by the time anything needs to sound.
 */
let audio = null;

function openAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    /* no audio on this device; prompts stay silent */
  }
}

/*
 * The first tap is what unlocks both of the things a browser will not grant
 * to a page nobody has touched: an audio context, and on some devices the
 * screen wake lock.
 */
['pointerdown', 'keydown'].forEach((type) =>
  addEventListener(
    type,
    () => {
      openAudio();
      keepAwake();
    },
    { once: true, passive: true }
  )
);

function chime() {
  // Nothing has been touched yet, so audio is not permitted. Staying quiet is
  // the correct behaviour; asking anyway only fills the console.
  if (!audio) return;

  try {
    if (audio.state === 'suspended') audio.resume();

    // Descending fourth, the way a cabin call sounds.
    [
      { hz: 1046.5, at: 0 },
      { hz: 784, at: 0.26 }
    ].forEach(({ hz, at }) => {
      const start = audio.currentTime + at;
      const osc = audio.createOscillator();
      const gain = audio.createGain();

      osc.type = 'sine';
      osc.frequency.value = hz;

      // Struck, then allowed to ring down -- a square-edged tone reads as an
      // error sound, which this is not.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);

      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  } catch {
    /* no audio on this device; the prompt still shows */
  }
}

function updateFuelPrompt() {
  const node = document.getElementById('fuel-prompt');
  if (!node || !state.model) return;

  const due = dueCheckpoint(state.model, state.timeline, getActuals(state.model));
  const key = due ? String(due.fix.index) : null;

  if (!due || dismissedPrompts.has(key)) {
    if (!node.hidden) {
      node.hidden = true;
      node.innerHTML = '';
    }
    return;
  }

  // Already showing this one: leave it alone so it does not steal the caret
  // out from under a half-typed figure.
  if (node.dataset.fixIndex === key) return;

  node.dataset.fixIndex = key;
  node.hidden = false;
  node.innerHTML = fuelPromptMarkup(state.model, due);
  node.querySelector('input')?.focus();
  chime();
}

function fuelPromptMarkup(model, due) {
  const { fix, why } = due;
  const unit = model.units === 'lbs' ? 'lb' : 'kg';

  return `<div class="prompt-card" role="dialog" aria-label="${escapeHtml(t('nl.fuelCheck'))}">
    <div class="prompt-head">
      <span class="prompt-why">${escapeHtml(t(`nl.due.${why}`))}</span>
      <b class="ltr">${escapeHtml(fix.ident)}</b>
    </div>
    <div class="prompt-plan">
      ${escapeHtml(t('nl.planned'))} <span class="ltr">${fmtNumber(fix.fuelOnBoard)} ${unit}</span>
    </div>
    <div class="prompt-row">
      <input class="fuel-input" type="text" inputmode="numeric" pattern="[0-9]*"
             enterkeyhint="done" autocomplete="off" maxlength="6"
             data-action="prompt-fuel" data-fix-index="${fix.index}"
             placeholder="${escapeHtml(t('nl.actual'))}"
             aria-label="${escapeHtml(`${t('nl.actual')} ${fix.ident}`)}">
      <button class="phase-btn go" data-action="prompt-save">${escapeHtml(t('nl.log'))}</button>
      <button class="phase-btn" data-action="prompt-skip">${escapeHtml(t('nl.later'))}</button>
    </div>
  </div>`;
}

setInterval(updateFuelPrompt, 5000);

/* -------------------------------------------------------------- glossary */

/**
 * Tap-to-decode for METAR/TAF/NOTAM abbreviations.
 *
 * highlightWx/highlightNotam (decode.js) mark the tokens they recognise with
 * `data-gloss` (which dictionary) and `data-code` (the bare code); nothing
 * about the definition itself is in the markup. It is looked up fresh here
 * from glossary.js, so there is exactly one place in the app that knows what
 * any given code means.
 *
 * A tooltip, not a dialog: anchored to the tapped token rather than centred,
 * and dismissed by almost anything -- another tap, Escape, scrolling, turning
 * the device -- because it answers a passing question and has nothing to ask
 * back.
 */
function toggleGlossary(token) {
  const node = document.getElementById('glossary');
  if (!node) return;

  const code = token.dataset.code;

  // Tapping the token that is already open closes it, the way a disclosure
  // normally behaves.
  if (!node.hidden && node.dataset.code === code) {
    closeGlossary();
    return;
  }

  const text = decodeToken(token.dataset.gloss, code);
  if (!text) return;

  node.dataset.code = code;
  node.innerHTML = `
    <b class="ltr">${escapeHtml(code)}</b>
    <span>${escapeHtml(text)}</span>
    <button class="gloss-close" data-action="glossary-close" aria-label="${escapeHtml(t('common.close'))}">✕</button>
  `;
  node.hidden = false;
  positionGlossary(node, token);
}

/** Anchored under the token, flipped above it when there is no room below. */
function positionGlossary(node, token) {
  const rect = token.getBoundingClientRect();
  const margin = 10;
  const w = node.offsetWidth;
  const h = node.offsetHeight;

  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - margin));
  let top = rect.bottom + 8;
  if (top + h > window.innerHeight - margin) top = rect.top - h - 8;

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function closeGlossary() {
  const node = document.getElementById('glossary');
  if (!node || node.hidden) return;
  node.hidden = true;
  node.innerHTML = '';
  delete node.dataset.code;
}

// Anchored to a token's on-screen position, so it cannot be left floating
// over content that has since scrolled or reflowed out from under it.
addEventListener('scroll', closeGlossary, { capture: true, passive: true });
addEventListener('resize', closeGlossary, { passive: true });

/* --------------------------------------------------------- milestone alerts */

/**
 * A banner for the moments worth interrupting for -- off-blocks, wheels-up,
 * top of descent.
 *
 * A banner rather than the centred dialog the fuel prompt uses: these carry no
 * question, so blocking the screen for them would be rude. They are dismissed
 * by tapping, and never raised twice for the same milestone -- "seen" is read
 * from the timeline's own persisted store (see markAlertSeen in timeline.js)
 * rather than a local Set, so a dismissal survives a reload instead of
 * bringing the same alert back the moment the page reopens.
 */
function updateAlert() {
  const node = document.getElementById('alert');
  if (!node || !state.model) return;

  const seen = new Set(state.timeline.seenAlerts || []);
  const due = dueAlert(state.model, state.timeline, seen);

  if (!due) {
    // The window for whatever was showing has closed. Left alone, an
    // undismissed banner would sit there for the rest of the flight.
    if (!node.hidden) {
      node.hidden = true;
      node.innerHTML = '';
      delete node.dataset.key;
    }
    return;
  }

  if (node.dataset.key === due.key) return;

  node.dataset.key = due.key;
  node.hidden = false;
  node.innerHTML = alertMarkup(due);
  chime();
  notify(due);
}

function alertMarkup(due) {
  const away = due.secondsAway;
  const when =
    away > 60
      ? `${t('alert.in')} ${fmtDuration(away)}`
      : away > -60
      ? t('alert.now')
      : t('alert.passed');

  return `<div class="alert-card">
    <span class="alert-key">${escapeHtml(t(`alert.${due.key}`))}</span>
    <span class="alert-when">${escapeHtml(when)}</span>
    <b class="ltr">${escapeHtml(fmtZulu(due.at))}</b>
    ${due.fix ? `<span class="alert-fix ltr">${escapeHtml(due.fix.ident)}</span>` : ''}
    <button class="alert-close" data-action="alert-dismiss" aria-label="${escapeHtml(t('common.close'))}">✕</button>
  </div>`;
}

/**
 * Mirrors an alert to the system notification tray.
 *
 * Only reaches the crew while the app is running -- a page that has been
 * closed cannot raise anything without a push server behind it. Silent when
 * permission was never granted, which is the default.
 */
function notify(due) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    navigator.serviceWorker?.ready.then((reg) =>
      reg.showNotification(`${t(`alert.${due.key}`)} · ${fmtZulu(due.at)}`, {
        body: `${state.model.flight.callsign || ''} ${state.model.origin?.icao || ''} → ${state.model.destination?.icao || ''}`.trim(),
        icon: 'icons/icon.svg',
        badge: 'icons/icon.svg',
        tag: `sbb-${due.key}`
      })
    );
  } catch {
    /* notifications unavailable; the banner still shows */
  }
}

setInterval(updateAlert, 5000);

/* ------------------------------------------------------------ screen wake */

/*
 * Keeps the display on while a briefing is open.
 *
 * A tablet on a stand dims and locks after a couple of minutes of not being
 * touched, which is exactly what a briefing does: it is read, not operated.
 * Losing the screen mid-flight means unlocking the device to see the fuel
 * check that just came due.
 *
 * The lock is released by the browser whenever the page is hidden, so it has
 * to be taken again on every return rather than once at startup. Requests can
 * also be refused until the page has been interacted with, which is why the
 * first tap retries it.
 *
 * The trade-off is battery: a screen that never sleeps is the largest draw on
 * a tablet. That is the instruction, and it is what a chart display does too.
 */
let wakeLock = null;

async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || el.app.hidden) return;
  if (wakeLock) return;

  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // Dropped by the browser on hide, or when the device decides otherwise.
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Refused -- needs a gesture, or the device does not offer it. Retried on
    // the next return to the page or the next tap.
    wakeLock = null;
  }
}

/* ------------------------------------------------------- install & alerts */

/*
 * Chrome and Android offer to install through an event the page has to catch
 * and hold onto; iOS has no such event and needs the crew to use Share ▸ Add
 * to Home Screen themselves. The button reflects whichever case applies rather
 * than promising something the device cannot do.
 */
let installPrompt = null;

addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  renderRail();
});

function installState() {
  const standalone =
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return 'installed';
  if (installPrompt) return 'available';
  // No event and not installed: iOS, where it is a manual gesture.
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'manual' : 'unavailable';
}

async function runInstall(trigger) {
  if (!installPrompt) {
    flash(trigger, t('install.manual'));
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  renderRail();
}

async function requestAlerts(trigger) {
  if (!('Notification' in window)) {
    flash(trigger, t('alert.unsupported'));
    return;
  }
  const result = await Notification.requestPermission();
  flash(trigger, result === 'granted' ? t('alert.on') : t('alert.off'));

  // renderRail() swaps this very button for its post-permission state
  // (granted hides it, denied mutes it) -- done immediately, that overwrites
  // flash()'s text before the tap that caused it even finishes rendering.
  setTimeout(renderRail, 1600);
}

/*
 * Rotating the iPad (or resizing a dev window) can cross the two-column
 * threshold; re-run the full chapter render so masonry rebalances from a flat
 * list rather than re-packing its own already-built row/column tree.
 *
 * Gated on width alone, because the masonry breakpoint is a width -- see
 * TWO_COL_MIN_WIDTH in masonry.js -- and a resize event fires for height-only
 * changes too. On Android, focusing a text input shrinks the layout viewport
 * to make room for the on-screen keyboard, which fires exactly that kind of
 * resize; without this guard the debounced handler tore down and rebuilt the
 * chapter underneath the input the crew had just tapped, so the freshly
 * inserted (unfocused) replacement dropped focus and the keyboard closed
 * itself half a second after opening. iOS does not fire a window resize for
 * its keyboard, which is why this only ever showed up on Android.
 */
let resizeTimer = null;
let lastWidth = innerWidth;
addEventListener('resize', () => {
  if (el.app.hidden || innerWidth === lastWidth) return;
  lastWidth = innerWidth;
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

function applySetupText() {
  document.getElementById('setup-heading').textContent = t('setup.heading');
  document.getElementById('setup-explain').textContent = t('setup.explain');
  document.getElementById('setup-label').textContent = t('setup.username');
  document.getElementById('setup-hint').textContent = t('setup.hint');
  el.demo.textContent = t('setup.demo');
  el.submit.textContent = t('setup.load');
}

// Tells the inline watchdog in index.html that the module graph loaded.
window.__briefingBooted = true;

// Offline support. Registered after boot so a failure here can never stop the
// app from starting, and skipped on localhost over plain http where some
// browsers refuse the registration anyway.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support unavailable; the app still works online */
    });
  });
}

applySetupText();

if (state.username) {
  el.username.value = state.username;
  load({ username: state.username });
}
