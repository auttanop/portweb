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
const
