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
 * TODO — CONFIRM AGAINST THE REAL TENANT BEFORE GOING LIVE
 * ------------------------------------------------------------------
 * I have not seen real output from the `purchase_traceability` view on
 * your tenant, so the names below are placeholders based on the view's
 * name and the kind of fields a traceability view usually has. Run:
 *
 *   curl -u 'username:password' \
 *     "https://test.farmforce.com/api/v0/view/purchase_traceability/?format=json&limit=1"
 *
 * ...and adjust VIEW_NAME, LOT_COLUMN, and ALLOWED_COLUMNS below to match
 * the real "columns" array that comes back. Nothing else needs to change.
 * ------------------------------------------------------------------
 */

const VIEW_NAME = 'purchase_traceability';

// The column whose value we match against the requested lot number.
// CONFIRM against real output — this is a guess based on common naming.
const LOT_COLUMN = 'Lot Number';

// Allowlist of columns that are safe to return to the public page.
// Anything in the API response NOT listed here is dropped before the
// data ever leaves this function. Add/remove field names to match the
// real view — do NOT switch this to "return everything" even
// temporarily, the view may contain internal farmer contact info.
const ALLOWED_COLUMNS = [
  'Lot Number',
  'Product',
  'Harvest Period',
  'Province',
  'District',
  'Village',
  'Farmer Group',
  'Number of Farmers',
  'Certification',
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

  return jsonResponse(200, { lot, groups: matches });
};

function sanitizeRow(columns, row) {
  const out = {};
  columns.forEach((colName, i) => {
    const isAllowed = ALLOWED_COLUMNS.some(
      (allowed) => allowed.toLowerCase() === String(colName).toLowerCase()
    );
    if (isAllowed) {
      out[colName] = row[i];
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
