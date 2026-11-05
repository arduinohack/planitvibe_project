const axios = require('axios');
const { googleMapsKey, redactKey } = require('./placeMap');
const { recordAiUsage } = require('./aiUsage');
const {
  INSUFFICIENT_MESSAGE,
  PLACES_CREDIT_COST,
  getBalance,
  deduct,
} = require('./aiCredits');

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
// Text Search Pro. Rating, review count, and price level are Enterprise.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.timeZone',
].join(',');
const ID_FIELD_MASK = 'places.id';
const MAX_RESULTS = 5;

function hasOwnKey(aiClient) {
  if (!aiClient || aiClient.source !== 'user' || aiClient.supported === false) return false;
  const key = aiClient.apiKey;
  return typeof key === 'string' && key.trim().length > 0;
}

function searchRequest(query, key, fieldMask) {
  return {
    url: SEARCH_URL,
    body: { textQuery: query, pageSize: MAX_RESULTS },
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': fieldMask,
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

function rowFromPlace(place, idOnly) {
  if (!place || typeof place !== 'object') return null;
  const googlePlaceId = placeIdOf(place);
  if (!googlePlaceId) return null;
  if (idOnly) return { googlePlaceId };
  const name = textOf(place.displayName);
  if (!name) return null;
  return {
    googlePlaceId,
    name,
    address: String(place.formattedAddress || '').trim(),
    timeZone: ianaTimeZone(place),
  };
}

function placesFromPayload(payload, idOnly) {
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
    const row = rowFromPlace(place, idOnly);
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

// Places API (New) Text Search. A balance above zero uses Pro. Zero uses
// Essentials (IDs Only). A user-owned key stays on Pro. Typing does not
// deduct credits and does not write AiUsage. Selection charges separately.
// Does not write a plan or an activity.
async function searchPlaces(query, { post, userId, aiClient } = {}) {
  const key = googleMapsKey();
  if (!key) {
    return { status: 503, msg: 'Google Maps is not configured' };
  }
  const q = String(query || '').trim();
  if (!q) {
    return { status: 400, msg: 'Query is required' };
  }

  const ownKey = hasOwnKey(aiClient);
  let idOnly = false;
  if (!ownKey) {
    const balance = await getBalance(userId);
    idOnly = !(balance > 0);
  }

  const request = searchRequest(q, key, idOnly ? ID_FIELD_MASK : FIELD_MASK);
  const fetchPlaces = post || defaultPost;
  let res;
  try {
    res = await fetchPlaces(request.url, request.body, request.headers);
  } catch (_) {
    return { status: 502, msg: 'Could not search places' };
  }

  const parsed = placesFromPayload(res && res.body, idOnly);
  if (parsed.error || !res || res.status < 200 || res.status >= 300) {
    const msg = redactKey(parsed.error || 'Could not search places', key);
    return { status: 502, msg };
  }
  return { status: 200, places: parsed.places, idOnly };
}

// Charges 0.5 when a result is chosen, unless the caller has a user-owned key.
// A short balance is 402 and writes nothing.
async function selectPlace({ userId, googlePlaceId, query, aiClient } = {}) {
  const id = String(googlePlaceId || '').trim();
  const q = String(query || '').trim();
  if (!id) return { status: 400, msg: 'Google Place ID is required' };
  if (!q) return { status: 400, msg: 'Query is required' };

  const ownKey = hasOwnKey(aiClient);
  if (!ownKey) {
    const balance = await getBalance(userId);
    if (!(balance >= PLACES_CREDIT_COST)) {
      return { status: 402, msg: INSUFFICIENT_MESSAGE };
    }
    const paid = await deduct(userId, PLACES_CREDIT_COST);
    if (!paid || !paid.ok) {
      return { status: 402, msg: INSUFFICIENT_MESSAGE };
    }
  }

  await recordAiUsage({
    userId,
    feature: 'placeSearch',
    provider: 'google',
    usedUserKey: ownKey,
    success: true,
    credits: ownKey ? undefined : PLACES_CREDIT_COST,
  });
  return { status: 200 };
}

module.exports = {
  searchPlaces,
  selectPlace,
  searchRequest,
  placesFromPayload,
  SEARCH_URL,
  FIELD_MASK,
  ID_FIELD_MASK,
  MAX_RESULTS,
};
