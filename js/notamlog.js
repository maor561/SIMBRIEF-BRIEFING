/**
 * Which NOTAMs have already been read.
 *
 * A crew reads the NOTAMs once when the plan comes out, then checks again
 * before pushback. The second read is only useful if it can show what changed
 * -- otherwise it is the same seventeen entries and the new one hides among
 * them.
 *
 * Unlike the fuel log this is deliberately *not* keyed per flight. Re-pulling
 * the OFP produces a fresh plan carrying mostly the same NOTAMs, and losing
 * the read state on every refresh would defeat the point. NOTAM numbers are
 * globally unique, so they key themselves.
 *
 * Entries are pruned once they are older than any NOTAM could still be live,
 * so the store cannot grow without bound.
 */

const STORE_KEY = 'sbb.notamsRead';
const KEEP_MS = 180 * 24 * 60 * 60 * 1000; // half a year

function read() {
  try {
    const data = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function write(data) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* storage disabled; every NOTAM simply reads as new each session */
  }
}

/**
 * A stable key for one NOTAM.
 *
 * The number is the natural identity, but SimBrief occasionally ships an
 * entry without one, and those still need to be tellable apart from each
 * other. Falling back to a digest of the text keeps them distinct without
 * inventing an id that could collide with a real number.
 */
export function notamKey(notam) {
  if (notam.id) return notam.id.trim().toUpperCase();

  const text = (notam.text || notam.raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // djb2: short, stable across sessions, and enough to separate a handful of
  // untitled entries at one airport.
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `#${(hash >>> 0).toString(36)}`;
}

/** Drops entries old enough that the NOTAM behind them cannot still matter. */
function prune(store) {
  const cutoff = Date.now() - KEEP_MS;
  let changed = false;
  for (const [key, seen] of Object.entries(store)) {
    if (!Number.isFinite(seen) || seen < cutoff) {
      delete store[key];
      changed = true;
    }
  }
  return changed;
}

export function isRead(notam) {
  const key = notamKey(notam);
  return key ? Number.isFinite(read()[key]) : false;
}

/** How many of an airport's NOTAMs have not been read yet. */
export function unreadCount(notams = []) {
  const store = read();
  return notams.filter((n) => {
    const key = notamKey(n);
    return key && !Number.isFinite(store[key]);
  }).length;
}

export function markRead(notams) {
  const list = Array.isArray(notams) ? notams : [notams];
  const store = read();
  const now = Date.now();

  let changed = prune(store);
  for (const notam of list) {
    const key = notamKey(notam);
    if (key && !Number.isFinite(store[key])) {
      store[key] = now;
      changed = true;
    }
  }

  if (changed) write(store);
  return store;
}

/** Puts an airport's NOTAMs back to unread, so the next read starts clean. */
export function markUnread(notams = []) {
  const store = read();
  let changed = false;
  for (const notam of notams) {
    const key = notamKey(notam);
    if (key && key in store) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) write(store);
  return store;
}
