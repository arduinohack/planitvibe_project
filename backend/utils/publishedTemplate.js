const { DateTime, IANAZone } = require('luxon');

const PUBLISH_DAILY_LIMIT = 5;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 140;
const CITY_MAX = 60;
const VIBE_MAX = 40;
const COVER_MAX = 500;
const BLOCKED_MESSAGE = "This template can't be published.";
const DATE_NOTE = 'Original calendar dates are not shown.';

const SPAM_TERMS = [
  'viagra',
  'cialis',
  'casino',
  'crypto airdrop',
  'buy now',
  'click here',
  'free money',
  'work from home',
  'onlyfans',
  'escort service',
];

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g;
const COMPACT_PHONE = /(?<!\d)\d{10,11}(?!\d)/g;
const LONG_NUMBER = /(?<!\d)\d{8,15}(?!\d)/g;
const STREET_PATTERN = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,6}(?:street|avenue|boulevard|terrace|circle|lane|drive|court|place|road|way|st|ave|blvd|ln|dr|ct|pl|rd|cir|ter)\b\.?/gi;
const LABELED_CODE = /\b(?:booking(?:\s+reference)?|confirmation(?:\s+(?:number|code|no\.?|#))?|conf\.?|record\s+locator|pnr|locator)\s*[#:]?\s*[A-Za-z0-9][A-Za-z0-9-]{2,}/gi;
const LOCATOR = /\b(?:[A-Za-z]{2,}\d{2,}|\d{2,}[A-Za-z]{2,})\b/g;
const PRIVATE_NOTE = /\d{8,}|\b(passport|password|ssn|social security|credit card|cvv)\b/i;

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimited(value, label, max, { required }) {
  if (value == null || value === '') {
    return required ? { error: `${label} is required.` } : { text: '' };
  }
  if (typeof value !== 'string') return { error: `${label} must be text.` };
  const text = value.trim();
  if (!text) return required ? { error: `${label} is required.` } : { text: '' };
  if (text.length > max) return { error: `${label} is too long.` };
  return { text };
}

function readCover(value) {
  if (value == null || value === '') return { url: '' };
  if (typeof value !== 'string') return { error: 'Cover image must be a link.' };
  const url = value.trim();
  if (!url) return { url: '' };
  if (url.length > COVER_MAX) return { error: 'Cover image link is too long.' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return { error: 'Cover image must be an http link.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Cover image must be an http link.' };
  }
  return { url };
}

function readPublishFields(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const title = readLimited(source.title, 'Title', TITLE_MAX, { required: true });
  if (title.error) return title;
  const description = readLimited(source.description, 'Description', DESCRIPTION_MAX, {
    required: true,
  });
  if (description.error) return description;
  if (/[\r\n]/.test(description.text)) return { error: 'Description must be one line.' };
  const city = readLimited(source.city, 'City', CITY_MAX, { required: true });
  if (city.error) return city;
  const vibe = readLimited(source.vibe, 'Vibe', VIBE_MAX, { required: true });
  if (vibe.error) return vibe;
  const length = source.tripLength;
  if (!Number.isInteger(length) || length < 1 || length > 60) {
    return { error: 'Trip length must be a number of days from 1 to 60.' };
  }
  const cover = readCover(source.coverImage);
  if (cover.error) return cover;
  return {
    title: title.text,
    description: description.text,
    city: city.text,
    vibe: vibe.text,
    tripLength: length,
    coverImage: cover.url,
  };
}

function creatorNameOf(user) {
  const name = [textOf(user && user.firstName), textOf(user && user.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || 'A PlanItVibe member';
}

function zoneName(timeZone) {
  const zone = textOf(timeZone);
  if (zone && IANAZone.isValidZone(zone)) return zone;
  return 'UTC';
}

function instantMs(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function calendarKey(ms, zone) {
  const local = DateTime.fromMillis(ms, { zone });
  if (!local.isValid) return null;
  return local.toISODate();
}

function clockLabel(ms, zone) {
  const local = DateTime.fromMillis(ms, { zone });
  if (!local.isValid) return '';
  const hour = String(local.hour).padStart(2, '0');
  const minute = String(local.minute).padStart(2, '0');
  return `${hour}:${minute}`;
}

function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function replacePattern(pattern, value) {
  pattern.lastIndex = 0;
  return String(value || '').replace(pattern, '');
}

function hasCode(value) {
  const text = String(value || '');
  if (matches(LABELED_CODE, text) || matches(LOCATOR, text)) return true;
  return matches(LONG_NUMBER, text)
    && !matches(COMPACT_PHONE, text)
    && !matches(PHONE_PATTERN, text);
}

function personalKinds(value) {
  const text = String(value || '');
  const kinds = [];
  if (matches(EMAIL_PATTERN, text)) kinds.push('Email');
  if (matches(PHONE_PATTERN, text) || matches(COMPACT_PHONE, text)) kinds.push('Phone number');
  if (matches(STREET_PATTERN, text)) kinds.push('Address');
  if (hasCode(text)) kinds.push('Booking or confirmation code');
  return kinds;
}

function redactSensitive(value) {
  return replacePattern(LONG_NUMBER, replacePattern(
    LOCATOR,
    replacePattern(LABELED_CODE, replacePattern(
      STREET_PATTERN,
      replacePattern(COMPACT_PHONE, replacePattern(
        PHONE_PATTERN,
        replacePattern(EMAIL_PATTERN, value),
      )),
    )),
  ))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function redactContact(value) {
  return redactSensitive(value);
}

function isPrivateNote(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  if (personalKinds(text).length) return true;
  return PRIVATE_NOTE.test(text);
}

function noteRemoved(removed, label, message) {
  removed.push(`${message} from ${label}`);
}

function stripLeg(leg) {
  if (!leg || typeof leg !== 'object') {
    return {
      origin: '',
      destination: '',
      originTimeZone: '',
      destinationTimeZone: '',
      departure: null,
      arrival: null,
      durationMinutes: null,
    };
  }
  const origin = redactContact(leg.origin);
  const destination = redactContact(leg.destination);
  return {
    origin,
    destination,
    originTimeZone: textOf(leg && leg.originTimeZone),
    destinationTimeZone: textOf(leg && leg.destinationTimeZone),
    departure: leg && leg.departure ? leg.departure : null,
    arrival: leg && leg.arrival ? leg.arrival : null,
    durationMinutes: typeof leg.durationMinutes === 'number' ? leg.durationMinutes : null,
  };
}

function stripActivity(activity, removed) {
  const rawName = textOf(activity && activity.name) || 'Activity';
  const nameKinds = personalKinds(rawName);
  const label = redactSensitive(rawName) || 'Activity';
  if (textOf(activity && activity.bookingReference)) {
    noteRemoved(removed, label, 'Booking reference removed');
  }
  if (textOf(activity && activity.confirmation)) {
    noteRemoved(removed, label, 'Confirmation number removed');
  }
  if (textOf(activity && activity.roomNumber)) {
    noteRemoved(removed, label, 'Room number removed');
  }
  if (textOf(activity && activity.gate)) noteRemoved(removed, label, 'Gate removed');
  if (textOf(activity && activity.baggageClaim)) {
    noteRemoved(removed, label, 'Baggage claim removed');
  }
  const address = textOf(activity && activity.location)
    || textOf(activity && activity.origin)
    || textOf(activity && activity.originCountry)
    || textOf(activity && activity.destination);
  if (address) noteRemoved(removed, label, 'Address removed');
  if (textOf(activity && activity.googlePlaceId)) {
    noteRemoved(removed, label, 'Place ID removed');
  }
  if (Array.isArray(activity && activity.urlLinks) && activity.urlLinks.length) {
    noteRemoved(removed, label, 'Link removed');
  }
  if (activity && activity.extras && typeof activity.extras === 'object'
    && Object.keys(activity.extras).length) {
    noteRemoved(removed, label, 'Private fields removed');
  }
  if (activity && typeof activity.cost === 'number' && activity.cost !== 0) {
    noteRemoved(removed, label, 'Cost removed');
  }
  if (textOf(activity && activity.serviceProvider)) {
    noteRemoved(removed, label, 'Provider removed');
  }
  const details = textOf(activity && activity.details);
  let publicDetails = '';
  if (details && isPrivateNote(details)) {
    noteRemoved(removed, label, 'Private note removed');
  } else if (details) {
    publicDetails = redactContact(details);
    if (publicDetails !== details) noteRemoved(removed, label, 'Contact details removed');
  }
  if (nameKinds.length) noteRemoved(removed, label, 'Contact details removed');
  const legs = Array.isArray(activity && activity.legs) ? activity.legs.map(stripLeg) : [];
  return {
    name: label,
    type: textOf(activity && activity.type) || 'activity',
    details: publicDetails,
    startTime: activity && activity.startTime ? activity.startTime : null,
    endTime: activity && activity.endTime ? activity.endTime : null,
    duration: typeof activity.duration === 'number' ? activity.duration : 0,
    durationMinutes: typeof activity.durationMinutes === 'number' ? activity.durationMinutes : null,
    timeZone: textOf(activity && activity.timeZone),
    startTimeZone: textOf(activity && activity.startTimeZone),
    endTimeZone: textOf(activity && activity.endTimeZone),
    legs,
  };
}

function spamHit(parts) {
  const hay = parts.filter(Boolean).join('\n').toLowerCase();
  return SPAM_TERMS.some((term) => hay.includes(term));
}

function dayNumbers(activities, zone) {
  let origin = null;
  for (const activity of activities) {
    const start = instantMs(activity.startTime);
    const key = start == null ? null : calendarKey(start, zone);
    if (key && (origin == null || key < origin)) origin = key;
  }
  if (!origin) return new Map();
  const numbers = new Map();
  let cursor = DateTime.fromISO(origin, { zone: 'utc' });
  let number = 1;
  const seen = new Set();
  for (const activity of activities) {
    const start = instantMs(activity.startTime);
    const key = start == null ? null : calendarKey(start, zone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
  }
  const last = [...seen].sort().pop();
  const end = DateTime.fromISO(last, { zone: 'utc' });
  while (cursor <= end) {
    numbers.set(cursor.toISODate(), number);
    cursor = cursor.plus({ days: 1 });
    number += 1;
  }
  return numbers;
}

function publicStops(activities, timeZone) {
  const zone = zoneName(timeZone);
  const days = dayNumbers(activities, zone);
  return activities.map((activity) => {
    const startMs = instantMs(activity.startTime);
    const endMs = instantMs(activity.endTime);
    const key = startMs == null ? null : calendarKey(startMs, zone);
    const legs = (activity.legs || []).map((leg) => {
      const departure = instantMs(leg.departure);
      const arrival = instantMs(leg.arrival);
      return {
        origin: leg.origin || '',
        destination: leg.destination || '',
        start: departure == null ? '' : clockLabel(departure, zone),
        end: arrival == null ? '' : clockLabel(arrival, zone),
      };
    }).filter((leg) => leg.origin || leg.destination || leg.start || leg.end);
    return {
      name: activity.name || 'Stop',
      type: activity.type || 'activity',
      day: key && days.has(key) ? days.get(key) : null,
      start: startMs == null ? '' : clockLabel(startMs, zone),
      end: endMs == null ? '' : clockLabel(endMs, zone),
      details: activity.details || '',
      legs,
    };
  });
}

function fieldLeak(removed, label, text) {
  const kinds = personalKinds(text);
  for (const kind of kinds) removed.push(`${kind} in the ${label}`);
  return kinds.length > 0;
}

function shareDraft(plan, activities, fields, creatorName) {
  const removed = [];
  const stripped = (activities || []).map((activity) => stripActivity(activity, removed));
  const titleLeak = fieldLeak(removed, 'title', fields.title);
  const descriptionLeak = fieldLeak(removed, 'description', fields.description);
  const cityLeak = fieldLeak(removed, 'city', fields.city);
  const vibeLeak = fieldLeak(removed, 'vibe', fields.vibe);
  removed.push(DATE_NOTE);
  const rawNotes = (activities || []).map((activity) => textOf(activity && activity.details));
  const rawNames = (activities || []).map((activity) => textOf(activity && activity.name));
  const blocked = titleLeak || descriptionLeak || cityLeak || vibeLeak || spamHit([
    fields.title,
    fields.description,
    fields.city,
    fields.vibe,
    ...rawNames,
    ...rawNotes,
    ...stripped.map((activity) => `${activity.name}\n${activity.details}`),
  ]);
  const stops = publicStops(stripped, plan && plan.timeZone);
  return {
    storedActivities: stripped,
    preview: {
      title: titleLeak ? (redactSensitive(fields.title) || 'Template') : fields.title,
      description: descriptionLeak ? redactSensitive(fields.description) : fields.description,
      city: cityLeak ? redactSensitive(fields.city) : fields.city,
      tripLength: fields.tripLength,
      vibe: vibeLeak ? redactSensitive(fields.vibe) : fields.vibe,
      coverImage: fields.coverImage,
      creatorName,
      stops,
    },
    removed,
    blocked: blocked ? BLOCKED_MESSAGE : null,
  };
}

function publicCard(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    description: doc.description || '',
    city: doc.city || '',
    tripLength: doc.tripLength,
    vibe: doc.vibe || '',
    coverImage: doc.coverImage || '',
    creatorName: doc.creatorName || 'A PlanItVibe member',
    copyCount: doc.copyCount || 0,
    viewCount: doc.viewCount || 0,
    sharePath: `/template.html?id=${encodeURIComponent(String(doc._id))}`,
  };
}

function ownerCard(doc) {
  return {
    ...publicCard(doc),
    published: doc.published !== false,
    sourcePlanId: doc.sourcePlanId || '',
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  PUBLISH_DAILY_LIMIT,
  BLOCKED_MESSAGE,
  readPublishFields,
  creatorNameOf,
  shareDraft,
  publicStops,
  publicCard,
  ownerCard,
  escapeRegExp,
};
