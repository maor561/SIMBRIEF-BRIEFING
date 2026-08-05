/**
 * Serverless proxy for the SimBrief OFP fetcher.
 *
 * The browser cannot call simbrief.com directly (no CORS headers), so every OFP
 * request goes through here. Also lets us keep a default username in an env var
 * instead of baking it into the client.
 *
 * GET /api/ofp?username=<simbrief username or pilot id>
 */

const SIMBRIEF_ENDPOINT = 'https://www.simbrief.com/api/xml.fetcher.php';
const FETCH_TIMEOUT_MS = 15000;

export default async function handler(req, res) {
  const username = (req.query?.username || process.env.SIMBRIEF_USERNAME || '').toString().trim();

  if (!username) {
    return json(res, 400, {
      error: 'missing_username',
      message: 'No SimBrief username supplied.'
    });
  }

  // SimBrief accepts either a username or a numeric pilot id. Anything with
  // characters outside that set is a client mistake, not a SimBrief error.
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    return json(res, 400, {
      error: 'invalid_username',
      message: 'Username contains characters SimBrief does not accept.'
    });
  }

  const isNumericId = /^\d+$/.test(username);
  const params = new URLSearchParams({ json: '1' });
  params.set(isNumericId ? 'userid' : 'username', username);
  const url = `${SIMBRIEF_ENDPOINT}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    const body = await upstream.text();

    // SimBrief reports an unknown user as HTTP 400 with a JSON body carrying
    // the real reason, so parse before judging the status code -- otherwise a
    // simple typo surfaces as an opaque upstream error.
    let ofp = null;
    try {
      ofp = JSON.parse(body);
    } catch {
      /* not JSON: fall through to the status check below */
    }

    const status = ofp?.fetch?.status;

    if (status && !/success/i.test(status)) {
      return json(res, 404, {
        error: 'no_ofp',
        message: `${status}. Check the username or generate a flight plan on SimBrief first.`
      });
    }

    if (!upstream.ok || !ofp) {
      return json(res, 502, {
        error: 'simbrief_http_error',
        message: `SimBrief responded with ${upstream.status}.`
      });
    }

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    return json(res, 200, ofp);
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return json(res, aborted ? 504 : 502, {
      error: aborted ? 'timeout' : 'fetch_failed',
      message: aborted ? 'SimBrief did not respond in time.' : 'Could not reach SimBrief.'
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
