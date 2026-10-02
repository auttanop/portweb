/**
 * trace-lot.js
 * ------------------------------------------------------------------
 * Netlify Function that proxies a single read-only lookup against the
 * Farmforce API, so the public kkqrscan.html page never sees (or can
 * leak) the Basic Auth credentials or any raw Farmforce data.
 *
 * Call shape from the browser:
 *   GET /api/trace-lot?lot=KK-CM-0142
 *
 * Required Netlify environment variables (set in Netlify dashboard,
 * never committed to the repo or pasted into chat):
 *   FARMFORCE_BASE_URL   e.g. https://test.farmforce.com
 *   FARMFORCE_USERNAME
 *   FARMFORCE_PASSWORD
 *
 * ------------------------------------------------------------------
 * CONFIRMED AGAINST THE REAL TEST TENANT on 2026-10-02
 * ------------------------------------------------------------------
 * Real response from:
 *   GET /api/v0/view/harvest_collections/?format=json&limit=5
 *
 *   "columns": ["Collected At", "Harvest Collection Number", "Type",
 *     "Comment", "Farmers", "Farmer IDs", "Lot Number", "Container Id",
 *     "Latest Facility", "Harvesting Activities", "Balance (Kg)",
 *     "Positions", "Creation Date", "Last Modified Date"]
 *
 * Each row is one farmer's individual contribution to a lot (not a
 * farmer group), e.g. Farmer A1 delivered 50.0 Kg into Lot-1234. A lot
 * typically has several rows, one per contributing farmer.
 *
 * purchase_traceability (the view originally guessed here) turned out
 * to be shipping/logistics data (Container ID, Ship Date, etc.), not
 * farmer-level traceability, hence the switch to harvest_collections.
 * ------------------------------------------------------------------
 */

const VIEW_NAME = 'harvest_collections';

// Confirmed exact column name from the real tenant.
const LOT_COLUMN = 'Lot Number';

// Allowlist of columns that are safe to return to the public page.
// Anything in the API response NOT listed here is dropped before the
// data ever leaves this function. "Comment" is deliberately excluded —
// it's free-text internal notes a staff member could type anything
// into, and "Creation Date"/"Last Modified Date" are internal metadata
// with no public use. Add fields here only after confirming they're
// safe to show publicly.
const ALLOWED_COLUMNS = [
  'Lot Number',
  'Collected At',
  'Harvest Collection Number',
  'Farmers',
  'Farmer IDs',
  'Container Id',
  'Balance (Kg)',
];

exports.handler = async function (event) {
  const lot = (event.queryStringParameters && event.queryStringParameters.lot || '').trim();

  if (!lot) {
    return jsonResponse(400, { error: 'Missing required "lot" query parameter.' });
  }

  const baseUrl = process.env.FARMFORCE_BASE_URL;
  const username = process.env.FARMFORCE_USERNAME;
  const password = process.env.FARMFORCE_PASSWORD;

  if (!baseUrl || !username || !password) {
    // Fails safe: tells the caller the server isn't configured yet,
    // without ever hinting at what the credentials are.
    return jsonResponse(500, { error: 'Farmforce API is not configured on the server yet.' });
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/v0/view/${VIEW_NAME}/?format=json&limit=500`;
  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  let apiResponse;
  try {
    apiResponse = await fetch(url, {
      headers: { Authorization: authHeader },
    });
  } catch (err) {
    return jsonResponse(502, { error: 'Could not reach the Farmforce API.' });
  }

  if (apiResponse.status === 401 || apiResponse.status === 403) {
    // Never echo back auth details — just flag that the server-side
    // credentials are wrong or lack permission for this view.
    return jsonResponse(502, { error: 'Farmforce API rejected the server credentials.' });
  }

  if (!apiResponse.ok) {
    return jsonResponse(502, { error: `Farmforce API returned ${apiResponse.status}.` });
  }

  let payload;
  try {
    payload = await apiResponse.json();
  } catch (err) {
    return jsonResponse(502, { error: 'Farmforce API returned an unexpected response.' });
  }

  const columns = payload.columns || [];
  const rows = payload.data || [];

  const lotColIndex = columns.findIndex(
    (c) => String(c).toLowerCase() === LOT_COLUMN.toLowerCase()
  );

  if (lotColIndex === -1) {
    return jsonResponse(500, {
      error: `Configured LOT_COLUMN "${LOT_COLUMN}" was not found in the view's columns. Update trace-lot.js to match the real column name.`,
      columnsSeenFromApi: columns, // safe to return during setup — remove once confirmed working
    });
  }

  const matches = rows
    .filter((r) => String(r.row[lotColIndex] || '').trim().toLowerCase() === lot.toLowerCase())
    .map((r) => sanitizeRow(columns, r.row));

  if (matches.length === 0) {
    return jsonResponse(404, { error: 'Lot not found.' });
  }

  // Each match is one farmer's individual contribution to this lot
  // (harvest_collections has one row per farmer per lot), not a
  // farmer group in the sense the Kad Kokoa demo page displays.
  return jsonResponse(200, { lot, collections: matches });
};

function sanitizeRow(columns, row) {
  const out = {};
  columns.forEach((colName, i) => {
    const isAllowed = ALLOWED_COLUMNS.some(
      (allowed) => allowed.toLowerCase() === String(colName).toLowerCase()
    );
    if (isAllowed) {
      const value = row[i];
      out[colName] = typeof value === 'string' ? value.trim() : value;
    }
  });
  return out;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
