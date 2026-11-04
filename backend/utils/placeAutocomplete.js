const axios = require('axios');
const { googleMapsKey, redactKey } = require('./placeMap');

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
// Text Search Pro only. Rating, review count, and price level are Enterprise.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.timeZone',
].join(',');
const MAX_RESULTS = 5;

function searchRequest(query, key) {
  return {
    url: SEARCH_URL,
    body: { textQuery: query, pageSize: MAX_RESULTS },
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': FIELD_MASK,
    },
  };
}

function googleMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const msg = data.error_message || data.errorMessage || data.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  if (data.error && typeof data.error.message === 'string' && data.error.message.trim()) {
    return data.error.message.trim();
  }
  if (typeof data.status === 'string' && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    return data.status.trim();
  }
  return '';
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text.trim();
  }
  return '';
}

function placeIdOf(place) {
  const id = String(place && place.id || '').trim();
  if (id.startsWith('places/')) return id.slice('places/'.length);
  return id;
}

// Places timeZone is { id: "America/New_York" }. Blank stays null.
function ianaTimeZone(place) {
  const zone = place && place.timeZone;
  if (typeof zone === 'string') {
    const text = zone.trim();
    return text || null;
  }
  if (zone && typeof zone === 'object') {
    const id = typeof zone.id === 'string' ? zone.id.trim() : '';
    return id || null;
  }
  return null;
}

function rowFromPlace(place) {
  if (!place || typeof place !== 'object') return null;
  const googlePlaceId = placeIdOf(place);
  const name = textOf(place.displayName);
  if (!googlePlaceId || !name) return null;
  return {
    googlePlaceId,
    name,
    address: String(place.formattedAddress || '').trim(),
    timeZone: ianaTimeZone(place),
  };
}

function placesFromPayload(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch (_) {
      return { error: 'Could not search places' };
    }
  }
  if (!data || typeof data !== 'object') {
    return { error: 'Could not search places' };
  }
  if (data.error) {
    return { error: googleMessage(data) || 'Could not search places' };
  }
  const rows = Array.isArray(data.places) ? data.places : [];
  const places = [];
  for (const place of rows) {
    const row = rowFromPlace(place);
    if (!row) continue;
    places.push(row);
    if (places.length >= MAX_RESULTS) break;
  }
  return { places };
}

async function defaultPost(url, body, headers) {
  const res = await axios.post(url, body, {
    timeout: 15000,
    headers,
    validateStatus: () => true,
  });
  return {
    status: res.status,
    body: res.data,
  };
}

// Places API (New) Text Search Pro. Returns googlePlaceId, name, address, and timeZone.
// Does not write a plan or an activity.
async function searchPlaces(query, { post } = {}) {
  const key = googleMapsKey();
  if (!key) {
    return { status: 503, msg: 'Google Maps is not configured' };
  }
  const q = String(query || '').trim();
  if (!q) {
    return { status: 400, msg: 'Query is required' };
  }

  const request = searchRequest(q, key);
  const fetchPlaces = post || defaultPost;
  let res;
  try {
    res = await fetchPlaces(request.url, request.body, request.headers);
  } catch (_) {
    return { status: 502, msg: 'Could not search places' };
  }

  const parsed = placesFromPayload(res && res.body);
  if (parsed.error || !res || res.status < 200 || res.status >= 300) {
    const msg = redactKey(parsed.error || 'Could not search places', key);
    return { status: 502, msg };
  }
  return { status: 200, places: parsed.places };
}

module.exports = {
  searchPlaces,
  searchRequest,
  placesFromPayload,
  SEARCH_URL,
  FIELD_MASK,
  MAX_RESULTS,
};
