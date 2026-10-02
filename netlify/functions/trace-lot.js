/**
 * trace-lot.js
 * ------------------------------------------------------------------
 * Netlify Function that proxies a lookup against the Farmforce API,
 * joining two views server-side so the public kkqrscan.html page never
 * sees (or can leak) the Basic Auth credentials or any raw Farmforce
 * data beyond what's explicitly allowlisted below.
 *
 * Call shape from the browser:
 *   GET /api/trace-lot?lot=Lot-1234
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
 * harvest_collections columns:
 *   ["Collected At", "Harvest Collection Number", "Type", "Comment",
 *    "Farmers", "Farmer IDs", "Lot Number", "Container Id",
 *    "Latest Facility", "Harvesting Activities", "Balance (Kg)",
 *    "Positions", "Creation Date", "Last Modified Date"]
 *   One row per farmer's individual contribution to a lot.
 *
 * farmers columns:
 *   ["Photo", "Farmer ID", "First Name", "Last Name", "Mobile Number",
 *    "Certification ID", "Village", "National ID Type", "Groups",
 *    "Farmer Tags", "Creation Date", "Last Modified Date"]
 *   "Farmer ID" here matches "Farmer IDs" in harvest_collections.
 *   "Groups" holds the farmer's group name as free text.
 *
 * groups_view columns:
 *   ["Name", "Description", "Farmers", "Staff", "Applets", "Surveys",
 *    "Zones", "Planting Campaigns", "HC Weight Change", "Facilities",
 *    "Code", "Address", "Telephone", "Fax", "Leader Name",
 *    "GPS of Group Office", "Creation Date", "Last Modified Date"]
 *   "Name" matches the farmers view's "Groups" value exactly.
 *   "GPS of Group Office" is a raw Postgres composite-type string, e.g.
 *     (301,"2026-10-02 10:40:34+00","",2,18.155101349,98.559579606,271,...)
 *   Fields 5 and 6 (1-indexed) are latitude and longitude. This function
 *   extracts just those two numbers via regex — never passes the raw
 *   composite string to the client, since it also contains internal
 *   DB ids and timestamps that aren't meant to be public.
 *
 * This function:
 *   1. Fetches harvest_collections, filters to rows matching the lot.
 *   2. Fetches farmers, builds a Farmer ID -> {group, village} map.
 *   3. Fetches groups_view, builds a group name -> {address, lat, lng} map.
 *   4. Joins all three and buckets individual farmer contributions into
 *      their groups, so the public page can render farmer-group cards
 *      with a real address and a working Google Maps link.
 * ------------------------------------------------------------------
 */

const HARVEST_VIEW = 'harvest_collections';
const FARMERS_VIEW = 'farmers';
const GROUPS_VIEW = 'groups_view';

const LOT_COLUMN = 'Lot Number';
const HC_FARMER_ID_COLUMN = 'Farmer IDs';

const FARMER_ID_COLUMN = 'Farmer ID';
const FARMER_GROUP_COLUMN = 'Groups';
const FARMER_VILLAGE_COLUMN = 'Village';

const GROUP_NAME_COLUMN = 'Name';
const GROUP_ADDRESS_COLUMN = 'Address';
const GROUP_GPS_COLUMN = 'GPS of Group Office';

// Matches the two high-precision decimal numbers (latitude, longitude)
// inside the raw Postgres composite string groups_view returns for GPS.
const GPS_PAIR_REGEX = /,(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,}),/;

// Fields pulled from harvest_collections per contribution. "Comment" is
// excluded (free-text internal notes), as are the *_Date metadata
// fields — none of that is meant for a public page.
const HC_ALLOWED_COLUMNS = [
  'Lot Number',
  'Collected At',
  'Harvest Collection Number',
  'Farmers',
  'Farmer IDs',
  'Balance (Kg)',
];

// Deliberately excludes Photo, Mobile Number, National ID Type, and
// Farmer Tags from the farmers view — none of that belongs on a public
// consumer-facing page, even though the join needs to read them.
const UNGROUPED_LABEL = 'Ungrouped';

exports.handler = async function (event) {
  const lot = (event.queryStringParameters && event.queryStringParameters.lot || '').trim();

  if (!lot) {
    return jsonResponse(400, { error: 'Missing required "lot" query parameter.' });
  }

  const baseUrl = process.env.FARMFORCE_BASE_URL;
  const username = process.env.FARMFORCE_USERNAME;
  const password = process.env.FARMFORCE_PASSWORD;

  if (!baseUrl || !username || !password) {
    return jsonResponse(500, { error: 'Farmforce API is not configured on the server yet.' });
  }

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  let harvestPayload, farmersPayload, groupsPayload;
  try {
    [harvestPayload, farmersPayload, groupsPayload] = await Promise.all([
      fetchView(baseUrl, HARVEST_VIEW, authHeader),
      fetchView(baseUrl, FARMERS_VIEW, authHeader),
      fetchView(baseUrl, GROUPS_VIEW, authHeader),
    ]);
  } catch (err) {
    if (err.authFailed) {
      return jsonResponse(502, { error: 'Farmforce API rejected the server credentials.' });
    }
    return jsonResponse(502, { error: err.message || 'Could not reach the Farmforce API.' });
  }

  // ---- Step 1: filter harvest_collections to this lot ----
  const hcColumns = harvestPayload.columns || [];
  const hcRows = harvestPayload.data || [];
  const lotColIndex = hcColumns.findIndex((c) => String(c).toLowerCase() === LOT_COLUMN.toLowerCase());

  if (lotColIndex === -1) {
    return jsonResponse(500, {
      error: `Configured LOT_COLUMN "${LOT_COLUMN}" was not found in harvest_collections' columns.`,
      columnsSeenFromApi: hcColumns,
    });
  }

  const matchingContributions = hcRows
    .filter((r) => String(r.row[lotColIndex] || '').trim().toLowerCase() === lot.toLowerCase())
    .map((r) => sanitizeRow(hcColumns, r.row, HC_ALLOWED_COLUMNS));

  if (matchingContributions.length === 0) {
    return jsonResponse(404, { error: 'Lot not found.' });
  }

  // ---- Step 2: build Farmer ID -> {group, village} map from farmers view ----
  const fColumns = farmersPayload.columns || [];
  const fRows = farmersPayload.data || [];
  const fIdIndex = fColumns.findIndex((c) => String(c).toLowerCase() === FARMER_ID_COLUMN.toLowerCase());
  const fGroupIndex = fColumns.findIndex((c) => String(c).toLowerCase() === FARMER_GROUP_COLUMN.toLowerCase());
  const fVillageIndex = fColumns.findIndex((c) => String(c).toLowerCase() === FARMER_VILLAGE_COLUMN.toLowerCase());

  const farmerLookup = {};
  if (fIdIndex !== -1) {
    fRows.forEach((r) => {
      const id = String(r.row[fIdIndex] || '').trim();
      if (!id) return;
      farmerLookup[id.toLowerCase()] = {
        group: fGroupIndex !== -1 ? String(r.row[fGroupIndex] || '').trim() : '',
        village: fVillageIndex !== -1 ? String(r.row[fVillageIndex] || '').trim() : '',
      };
    });
  }

  // ---- Step 2b: build group name -> {address, lat, lng} map from groups_view ----
  const gColumns = groupsPayload.columns || [];
  const gRows = groupsPayload.data || [];
  const gNameIndex = gColumns.findIndex((c) => String(c).toLowerCase() === GROUP_NAME_COLUMN.toLowerCase());
  const gAddressIndex = gColumns.findIndex((c) => String(c).toLowerCase() === GROUP_ADDRESS_COLUMN.toLowerCase());
  const gGpsIndex = gColumns.findIndex((c) => String(c).toLowerCase() === GROUP_GPS_COLUMN.toLowerCase());

  const groupInfoLookup = {};
  if (gNameIndex !== -1) {
    gRows.forEach((r) => {
      const name = String(r.row[gNameIndex] || '').trim();
      if (!name) return;
      const address = gAddressIndex !== -1 ? String(r.row[gAddressIndex] || '').trim() : '';
      let lat = null, lng = null;
      if (gGpsIndex !== -1) {
        const raw = String(r.row[gGpsIndex] || '');
        const m = raw.match(GPS_PAIR_REGEX);
        if (m) {
          lat = parseFloat(m[1]);
          lng = parseFloat(m[2]);
        }
      }
      groupInfoLookup[name.toLowerCase()] = { address, lat, lng };
    });
  }

  // ---- Step 3: join + bucket contributions into their groups ----
  const groupsMap = {};
  let totalWeight = 0;
  const distinctFarmerIds = new Set();

  matchingContributions.forEach((c) => {
    const farmerId = String(c['Farmer IDs'] || '').trim();
    distinctFarmerIds.add(farmerId.toLowerCase());

    const info = farmerLookup[farmerId.toLowerCase()] || { group: '', village: '' };
    const groupName = info.group || UNGROUPED_LABEL;
    const weight = parseFloat(c['Balance (Kg)']) || 0;
    totalWeight += weight;

    if (!groupsMap[groupName]) {
      const locationInfo = groupInfoLookup[groupName.toLowerCase()] || { address: '', lat: null, lng: null };
      groupsMap[groupName] = {
        name: groupName,
        village: info.village || '',
        address: locationInfo.address,
        lat: locationInfo.lat,
        lng: locationInfo.lng,
        farmerCount: 0,
        totalWeight: 0,
        farmers: [],
      };
    }
    const g = groupsMap[groupName];
    g.farmerCount += 1;
    g.totalWeight += weight;
    g.farmers.push({
      name: c['Farmers'],
      farmerId: c['Farmer IDs'],
      collectedAt: c['Collected At'],
      harvestCollectionNumber: c['Harvest Collection Number'],
      weight: c['Balance (Kg)'],
    });
  });

  const groups = Object.values(groupsMap).map((g) => ({
    name: g.name,
    village: g.village,
    address: g.address,
    lat: g.lat,
    lng: g.lng,
    farmerCount: g.farmerCount,
    totalWeight: g.totalWeight.toFixed(1),
    farmers: g.farmers,
  }));

  return jsonResponse(200, {
    lot,
    totalFarmers: distinctFarmerIds.size,
    totalWeight: totalWeight.toFixed(1),
    groups,
  });
};

async function fetchView(baseUrl, viewName, authHeader) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v0/view/${viewName}/?format=json&limit=500`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: authHeader } });
  } catch (err) {
    throw new Error(`Could not reach the Farmforce API (${viewName}).`);
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('auth failed');
    err.authFailed = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Farmforce API returned ${res.status} for ${viewName}.`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Farmforce API returned an unexpected response for ${viewName}.`);
  }
}

function sanitizeRow(columns, row, allowedColumns) {
  const out = {};
  columns.forEach((colName, i) => {
    const isAllowed = allowedColumns.some(
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
