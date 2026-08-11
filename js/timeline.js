/**
 * The flight as it actually runs, against the flight as it was planned.
 *
 * An OFP is written before anything happens, so every time in it is a
 * prediction anchored to a scheduled departure. The moment a flight goes late
 * -- and they mostly do -- every downstream figure on every screen is quietly
 * wrong, including the waypoint times a crew would check fuel against.
 *
 * This tracks the turnaround as a chain of phases, each timed, each closed by
 * hand. Completing the takeoff phase stamps the real wheels-up time, and from
 * that instant the whole chain is recomputed from the OFP's own intervals:
 *
 *   landing    = takeoff + enroute time
 *   on-blocks  = landing + taxi in
 *   each fix   = takeoff + that fix's cumulative time
 *
 * The planned times are never overwritten -- they stay alongside, because the
 * gap between them is the delay, and that is worth seeing.
 */

const STORE_KEY = 'sbb.timeline';

/**
 * The two spans that carry a real anchor into the OFP's clock.
 *
 * Nothing else is tracked. Ground handling has no bearing on any figure in
 * the briefing -- knowing how long boarding took changes no fuel number and
 * no waypoint time -- so timing it would be bookkeeping for its own sake.
 * These two do: one stamps wheels-up, which the whole clock is rebuilt from,
 * and one stamps touchdown.
 */
export const PHASES = [
  // Runs from the moment the crew starts it until wheels leave the ground.
  { key: 'takeoff', labelKey: 'phase.takeoff', anchor: 'off' },
  // Opens automatically at wheels-up and runs the flight; closing it stamps
  // touchdown.
  { key: 'landing', labelKey: 'phase.landing', anchor: 'on' }
];

export const PHASE_KEYS = PHASES.map((p) => p.key);

function phaseAt(index) {
  return PHASES[index] || null;
}

export function phaseFor(key) {
  return PHASES.find((p) => p.key === key) || null;
}

/* ------------------------------------------------------------------ store */

/** Distinguishes one OFP from the next, so a new plan starts clean. */
function flightKey(model) {
  const stamp = model.generatedAt instanceof Date ? model.generatedAt.getTime() : model.generatedAt;
  return `${model.flight.callsign || model.flight.number || 'FLT'}-${stamp || 0}`;
}

function read() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function write(data) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* storage disabled; the timeline simply does not survive a reload */
  }
}

const EMPTY = { phases: {}, current: null };

/** The timeline for this flight, or a clean one if none has been started. */
export function getTimeline(model) {
  const store = read();
  if (store.key !== flightKey(model) || !store.timeline) return { ...EMPTY };
  return { ...EMPTY, ...store.timeline };
}

function save(model, timeline) {
  write({ key: flightKey(model), timeline });
  return timeline;
}

export function resetTimeline(model) {
  return save(model, { ...EMPTY });
}

/* ---------------------------------------------------------------- driving */

/**
 * Opens a phase's timer. Starting one closes nothing by itself -- a phase is
 * only ever finished deliberately, because "we are done fuelling" is a fact
 * about the aircraft, not about the clock.
 */
export function startPhase(model, key, at = Date.now()) {
  if (!phaseFor(key)) return getTimeline(model);
  const timeline = getTimeline(model);
  const existing = timeline.phases[key];
  if (existing?.startedAt) return timeline;

  timeline.phases = { ...timeline.phases, [key]: { startedAt: at, endedAt: null } };
  timeline.current = key;
  return save(model, timeline);
}

/**
 * Closes a phase and opens the next one, so the chain walks itself forward.
 * A phase closed without ever being started is stamped at `at` for both, which
 * covers the honest case of remembering only once it is already over.
 */
export function completePhase(model, key, at = Date.now()) {
  const index = PHASE_KEYS.indexOf(key);
  if (index < 0) return getTimeline(model);

  const timeline = getTimeline(model);
  const existing = timeline.phases[key] || {};
  timeline.phases = {
    ...timeline.phases,
    [key]: { startedAt: existing.startedAt ?? at, endedAt: at }
  };

  const next = phaseAt(index + 1);
  if (next && !timeline.phases[next.key]?.startedAt) {
    timeline.phases[next.key] = { startedAt: at, endedAt: null };
    timeline.current = next.key;
  } else {
    timeline.current = next ? next.key : null;
  }

  return save(model, timeline);
}

/** Undoes a completion, for the mis-tap. The next phase reverts with it. */
export function reopenPhase(model, key) {
  const index = PHASE_KEYS.indexOf(key);
  if (index < 0) return getTimeline(model);

  const timeline = getTimeline(model);
  if (!timeline.phases[key]) return timeline;

  timeline.phases = { ...timeline.phases, [key]: { ...timeline.phases[key], endedAt: null } };
  const next = phaseAt(index + 1);
  if (next) delete timeline.phases[next.key];
  timeline.current = key;
  return save(model, timeline);
}

/* ---------------------------------------------------------------- reading */

export function phaseState(timeline, key) {
  const entry = timeline.phases?.[key];
  if (!entry?.startedAt) return 'pending';
  return entry.endedAt ? 'done' : 'running';
}

export function phaseElapsed(timeline, key, now = Date.now()) {
  const entry = timeline.phases?.[key];
  if (!entry?.startedAt) return null;
  return Math.max(0, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
}

/** When the aircraft actually left the ground, if the crew has said so. */
export function actualOff(timeline) {
  const entry = timeline.phases?.takeoff;
  return entry?.endedAt ? new Date(entry.endedAt) : null;
}

/** When it actually touched down. */
export function actualOn(timeline) {
  const entry = timeline.phases?.landing;
  return entry?.endedAt ? new Date(entry.endedAt) : null;
}

/**
 * The flight's clock, planned and -- once takeoff is stamped -- actual.
 *
 * Landing is the measured time if it has been marked, otherwise the takeoff
 * time plus the planned enroute time. Both are worth having: before touchdown
 * the projection is the useful number, after it the fact is.
 */
export function rebasedTimes(model, timeline) {
  const times = model.times;
  const off = actualOff(timeline);
  const planned = {
    off: times.estOff || times.schedOff || null,
    on: times.estOn || times.schedOn || null,
    in: times.estIn || times.schedIn || null
  };

  if (!off) return { started: false, planned, actual: null, delaySeconds: null };

  const onMeasured = actualOn(timeline);
  const on = onMeasured || addSeconds(off, times.estTimeEnroute);
  const inBlocks = on ? addSeconds(on, times.taxiIn) : null;

  return {
    started: true,
    planned,
    actual: { off, on, in: inBlocks, onIsMeasured: Boolean(onMeasured) },
    // How far off the plan the flight actually went, in seconds. Positive is
    // late, which is the usual direction.
    delaySeconds: planned.off ? Math.round((off.getTime() - planned.off.getTime()) / 1000) : null
  };
}

function addSeconds(date, seconds) {
  if (!date || !Number.isFinite(seconds)) return null;
  return new Date(date.getTime() + seconds * 1000);
}

/**
 * When the aircraft is expected over a fix, on the real clock.
 *
 * Falls back to the planned takeoff time before START, so the navlog reads in
 * wall-clock terms from the outset rather than only once airborne.
 */
export function fixEta(model, timeline, fix) {
  if (!Number.isFinite(fix?.timeTotal)) return null;
  const off = actualOff(timeline) || model.times.estOff || model.times.schedOff;
  return off ? addSeconds(off instanceof Date ? off : new Date(off), fix.timeTotal) : null;
}

/* ------------------------------------------------------- prompt cadence */

const MODE_KEY = 'sbb.fuelPromptMode';

/** 'key' asks at the points that carry information; 'all' at every fix. */
export function getPromptMode() {
  try {
    return globalThis.localStorage?.getItem(MODE_KEY) === 'all' ? 'all' : 'key';
  } catch {
    return 'key';
  }
}

export function setPromptMode(mode) {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode === 'all' ? 'all' : 'key');
  } catch {
    /* storage disabled; the choice lasts the session only */
  }
  return getPromptMode();
}

/**
 * The fixes worth stopping at to log the fuel on board.
 *
 * By default not every waypoint: this flight has thirty-two, and a prompt at
 * each one becomes something to dismiss rather than something to read. The
 * points that carry information are the top of climb (where the climb burn is
 * finally known), each hour of cruise (where a trend shows), the top of
 * descent (the last point a diversion is cheap) and the destination.
 *
 * A crew that wants the full log can have it: 'all' mode returns every fix.
 */
export function fuelCheckpoints(model, mode = getPromptMode()) {
  const fixes = model.navlog.filter((f) => Number.isFinite(f.timeTotal));
  if (!fixes.length) return [];

  if (mode === 'all') {
    return fixes
      .filter((fix) => Number.isFinite(fix.fuelOnBoard))
      .map((fix) => ({ fix, why: 'fix' }));
  }

  const chosen = new Map();
  const take = (fix, why) => {
    if (fix && !chosen.has(fix.index)) chosen.set(fix.index, { fix, why });
  };

  const topOfClimb = fixes.find((f) => f.stage === 'CRZ');
  // SimBrief spells descent 'DSC'; accept 'DES' too rather than depend on it.
  const topOfDescent = fixes.find((f) => f.stage === 'DSC' || f.stage === 'DES');

  take(topOfClimb, 'toc');

  if (topOfClimb) {
    // Stop short of the descent point: an hourly check twenty minutes before
    // one that is about to happen anyway is a prompt with nothing to add.
    const end = topOfDescent ? topOfDescent.timeTotal : fixes[fixes.length - 1].timeTotal;
    const until = end - 20 * 60;
    for (let at = topOfClimb.timeTotal + 3600; at < until; at += 3600) {
      take(nearestFix(fixes, at), 'cruise');
    }
  }

  take(topOfDescent, 'tod');
  take(fixes[fixes.length - 1], 'destination');

  return [...chosen.values()].sort((a, b) => a.fix.timeTotal - b.fix.timeTotal);
}

/** The fix closest in time to a given point in the flight. */
function nearestFix(fixes, seconds) {
  let best = null;
  let bestGap = Infinity;
  for (const fix of fixes) {
    const gap = Math.abs(fix.timeTotal - seconds);
    if (gap < bestGap) {
      bestGap = gap;
      best = fix;
    }
  }
  return best;
}

/**
 * The checkpoint the flight has reached but has no reading for yet -- what a
 * prompt should be asking about. Null until takeoff is stamped, and null once
 * everything due has been answered.
 */
export function dueCheckpoint(model, timeline, actuals, now = Date.now(), mode = getPromptMode()) {
  const off = actualOff(timeline);
  if (!off) return null;

  const elapsed = (now - off.getTime()) / 1000;
  const reached = fuelCheckpoints(model, mode).filter((c) => c.fix.timeTotal <= elapsed);

  // Oldest unanswered first: falling behind should not skip the earlier one.
  return reached.find(({ fix }) => !Number.isFinite(actuals[fix.index])) || null;
}

/**
 * Which leg the flight is on right now: the last fix already passed and the
 * one being flown towards. Null until takeoff is stamped, since before that
 * there is no real clock to place the aircraft on.
 */
export function currentLeg(model, timeline, now = Date.now()) {
  const off = actualOff(timeline);
  if (!off || !model.navlog.length) return null;

  const elapsed = (now - off.getTime()) / 1000;
  if (elapsed < 0) return null;

  let passed = null;
  for (const fix of model.navlog) {
    if (Number.isFinite(fix.timeTotal) && fix.timeTotal <= elapsed) passed = fix;
    else break;
  }

  const next = model.navlog.find((f) => Number.isFinite(f.timeTotal) && f.timeTotal > elapsed) || null;
  return { passed, next, elapsed: Math.round(elapsed) };
}
