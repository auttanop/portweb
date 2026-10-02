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
 * This function:
 *   1. Fetches harvest_collections, filters to rows matching the lot.
 *   2. Fetches farmers, builds a Farmer ID -> {group, village} map.
 *   3. Joins the two and buckets individual farmer contributions into
 *      their groups, so the public page can render farmer-group cards
 *      instead of a flat list of individual farmers.
 * ------------------------------------------------------------------
 */

const HARVEST_VIEW = 'harvest_collections';
const FARMERS_VIEW = 'farmers';

const LOT_COLUMN = 'Lot Number';
const HC_FARMER_ID_COLUMN = 'Farmer IDs';

const FARMER_ID_COLUMN = 'Farmer ID';
const FARMER_GROUP_COLUMN = 'Groups';
const FARMER_VILLAGE_COLUMN = 'Village';

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
// Farmer Tags from
