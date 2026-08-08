/**
 * Serverless proxy for the VATSIM network datafeed.
 *
 * Two reasons this does not run straight from the browser: the feed carries no
 * CORS headers we can rely on, and VATSIM asks clients not to poll it harder
 * than once every 15 seconds. Proxying lets the CDN hold one copy for everyone
 * instead of every open tab hitting the network itself.
 *
 * The payload is ~10 MB of mostly pilot positions, which the briefing has no
 * use for, so only the controller and ATIS entries are passed on.
 *
 * GET /api/vatsim
 */

const VATSIM_ENDPOINT = 'https://data.vatsim.net/v3/vatsim-data.json';
const FETCH_TIMEOUT_MS = 12000;

export default async function handler(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(VATSIM_ENDPOINT, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!upstream.ok) {
      return json(res, 502, {
        error: 'vatsim_http_error',
        message: `VATSIM responded with ${upstream.status}.`
      });
    }

    const feed = await upstream.json();

    // Facility 0 is an observer, not a controlling position.
    const controllers = (feed.controllers || [])
      .filter((c) => Number(c.facility) > 0)
      .map(slim);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=60');
    return json(res, 200, {
      updatedAt: feed.general?.update_timestamp || null,
      controllers,
      atis: (feed.atis || []).map(slim)
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return json(res, aborted ? 504 : 502, {
      error: aborted ? 'timeout' : 'fetch_failed',
      message: aborted ? 'VATSIM did not respond in time.' : 'Could not reach VATSIM.'
    });
  } finally {
    clearTimeout(timer);
  }
}

function slim(entry) {
  return {
    callsign: entry.callsign,
    frequency: entry.frequency,
    facility: Number(entry.facility),
    name: entry.name,
    logonTime: entry.logon_time,
    atis: Array.isArray(entry.text_atis) ? entry.text_atis.join(' ') : entry.text_atis || null
  };
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
