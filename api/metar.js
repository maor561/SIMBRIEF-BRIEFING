/**
 * Serverless proxy for VATSIM's METAR feed.
 *
 * The OFP carries a METAR snapshot taken when the plan was generated, which
 * goes stale the moment the plan sits for an hour. This fetches the current
 * one for the fields on the plan so the briefing can show live weather beside
 * the planned figures.
 *
 * VATSIM does serve this with an open CORS header, so the browser could call
 * it directly; it is proxied anyway to keep one place for outbound calls and
 * to let the CDN hold a copy -- METARs only change once or twice an hour, so
 * every open tab hitting the origin would be waste.
 *
 * TAF is deliberately not here: the feed is METAR-only, so forecasts stay as
 * the OFP issued them.
 *
 * GET /api/metar?ids=LEBL,LCLK,LCPH
 */

const VATSIM_METAR = 'https://metar.vatsim.net/metar.php';
const FETCH_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  const raw = (req.query?.ids || '').toString().trim().toUpperCase();

  // Four-letter ICAO codes only, capped so one request cannot be turned into
  // a bulk scrape of the feed.
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[A-Z]{4}$/.test(id))
    .slice(0, 8);

  if (!ids.length) {
    return json(res, 400, {
      error: 'missing_ids',
      message: 'Supply one or more four-letter ICAO codes.'
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${VATSIM_METAR}?id=${ids.join(',')}`, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' }
    });

    if (!upstream.ok) {
      return json(res, 502, {
        error: 'vatsim_http_error',
        message: `VATSIM responded with ${upstream.status}.`
      });
    }

    // One METAR per line, each starting with its station code.
    const metars = {};
    for (const line of (await upstream.text()).split('\n')) {
      const text = line.trim();
      const station = text.slice(0, 4);
      if (ids.includes(station)) metars[station] = text;
    }

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=600');
    return json(res, 200, { fetchedAt: new Date().toISOString(), metars });
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

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
