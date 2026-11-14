'use strict';

/**
 * normalizer.js
 *
 * Responsibilities:
 *   1. Provider adapters: web form, Calendly, Chili Piper, product signup, and
 *      already-canonical payloads all become one canonical event schema.
 *   2. Validation: email, event type, timestamp (including future-skew checks).
 *   3. UTM normalization: lowercase + trim + whitespace collapse, then a
 *      deterministic aliasing dictionary for source and medium.
 *   4. Fallback inference when UTMs are missing: click IDs first, then the
 *      referrer, then a clean direct / none default.
 *   5. Deterministic event hashing (FNV-1a 64-bit) used as the touchpoint ID.
 *   6. Touchpoint history: parse, dedupe by event ID, sort, cap by count and
 *      by serialized character length.
 *
 * I keep everything between the n8n-core:normalizer markers free of require()
 * calls and Node-only globals (URL has a pure-JS fallback), because
 * scripts/build-workflow.js embeds that region verbatim into the n8n Code
 * nodes. One source of truth, two runtimes.
 */

// <n8n-core:normalizer>
const CANONICAL_EVENT_TYPES = ['form_submission', 'meeting_booked', 'product_signup'];
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const CLICK_ID_FIELDS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'li_fat_id', 'fbclid'];
const MAX_TEXT_LENGTH = 255;
const MAX_ASSET_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_HISTORY_URL_LENGTH = 300;
const FUTURE_SKEW_MS = 10 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dictionary(entries) {
  // Prototype-free lookup tables, so a utm_source of "constructor" can never
  // resolve to an Object.prototype member.
  const table = Object.create(null);
  Object.keys(entries).forEach(function (key) { table[key] = entries[key]; });
  return Object.freeze(table);
}

const EVENT_TYPE_ALIASES = dictionary({
  form_submission: 'form_submission',
  form_submit: 'form_submission',
  form_submitted: 'form_submission',
  form: 'form_submission',
  web_form: 'form_submission',
  meeting_booked: 'meeting_booked',
  invitee_created: 'meeting_booked',
  meeting_scheduled: 'meeting_booked',
  booking: 'meeting_booked',
  demo_booked: 'meeting_booked',
  product_signup: 'product_signup',
  user_signup: 'product_signup',
  user_created: 'product_signup',
  signup: 'product_signup',
  sign_up: 'product_signup',
  trial_started: 'product_signup'
});

const SOURCE_ALIASES = dictionary({
  fb: 'facebook',
  facebook: 'facebook',
  'facebook.com': 'facebook',
  meta: 'facebook',
  ig: 'instagram',
  insta: 'instagram',
  instagram: 'instagram',
  'instagram.com': 'instagram',
  li: 'linkedin',
  lnkd: 'linkedin',
  'lnkd.in': 'linkedin',
  linkedin: 'linkedin',
  'linkedin.com': 'linkedin',
  google: 'google',
  'google.com': 'google',
  adwords: 'google',
  googleads: 'google',
  google_ads: 'google',
  bing: 'bing',
  'bing.com': 'bing',
  microsoft_ads: 'bing',
  msads: 'bing',
  twitter: 'x',
  'twitter.com': 'x',
  x: 'x',
  'x.com': 'x',
  't.co': 'x',
  yt: 'youtube',
  youtube: 'youtube',
  'youtube.com': 'youtube',
  reddit: 'reddit',
  'reddit.com': 'reddit',
  e_mail: 'email',
  email: 'email',
  email_newsletter: 'email'
});

const MEDIUM_ALIASES = dictionary({
  cpc: 'paid_search',
  ppc: 'paid_search',
  paidsearch: 'paid_search',
  paid_search: 'paid_search',
  sem: 'paid_search',
  search_ads: 'paid_search',
  paidsocial: 'paid_social',
  paid_social: 'paid_social',
  social_paid: 'paid_social',
  sponsored_social: 'paid_social',
  social_ads: 'paid_social',
  social: 'organic_social',
  organic_social: 'organic_social',
  social_organic: 'organic_social',
  social_media: 'organic_social',
  sm: 'organic_social',
  email: 'email',
  e_mail: 'email',
  email_newsletter: 'email',
  newsletter: 'email',
  mail: 'email',
  display: 'display',
  banner: 'display',
  cpm: 'display',
  programmatic: 'display',
  organic: 'organic_search',
  seo: 'organic_search',
  organic_search: 'organic_search',
  referral: 'referral',
  referrer: 'referral',
  referer: 'referral',
  affiliate: 'affiliate',
  affiliates: 'affiliate',
  partner: 'affiliate',
  none: 'none',
  '(none)': 'none'
});

// Order matters: the first click ID present wins.
const CLICK_ID_RULES = [
  { param: 'gclid', source: 'google', medium: 'paid_search' },
  { param: 'gbraid', source: 'google', medium: 'paid_search' },
  { param: 'wbraid', source: 'google', medium: 'paid_search' },
  { param: 'msclkid', source: 'bing', medium: 'paid_search' },
  { param: 'li_fat_id', source: 'linkedin', medium: 'paid_social' },
  { param: 'fbclid', source: 'facebook', medium: 'paid_social' }
];

const SEARCH_ENGINE_HOSTS = dictionary({
  'google.com': 'google',
  'bing.com': 'bing',
  'duckduckgo.com': 'duckduckgo',
  'yahoo.com': 'yahoo'
});

const SOCIAL_HOSTS = dictionary({
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  'lnkd.in': 'linkedin',
  't.co': 'x',
  'x.com': 'x',
  'twitter.com': 'x',
  'youtube.com': 'youtube',
  'reddit.com': 'reddit'
});

const GOOGLE_COUNTRY_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

function has(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    if (!isBlank(arguments[i])) return arguments[i];
  }
  return null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function lowerKeys(value) {
  const out = {};
  const source = asObject(value);
  Object.keys(source).forEach(function (key) {
    const lowered = key.toLowerCase();
    if (!has(out, lowered)) out[lowered] = source[key];
  });
  return out;
}

function cleanText(value, maxLength) {
  if (isBlank(value)) return null;
  if (typeof value === 'object') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength || MAX_TEXT_LENGTH) : null;
}

function normalizeToken(value) {
  const text = cleanText(value);
  return text ? text.toLowerCase() : null;
}

function stripWww(host) {
  return String(host || '').replace(/^www\./, '');
}

function hostMatches(host, domain) {
  return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
}

function parseUrlFallback(text) {
  const match = /^(https?):\/\/([^/?#:@]+)(:\d+)?([^?#]*)(\?[^#]*)?/i.exec(text);
  if (!match) return null;
  const params = {};
  if (match[5]) {
    match[5].slice(1).split('&').forEach(function (pair) {
      if (!pair) return;
      const index = pair.indexOf('=');
      const rawKey = index < 0 ? pair : pair.slice(0, index);
      const rawValue = index < 0 ? '' : pair.slice(index + 1);
      let key;
      let val;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' ')).toLowerCase();
        val = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch (error) {
        return;
      }
      if (!has(params, key)) params[key] = val;
    });
  }
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  let port = match[3] || '';
  if ((scheme === 'https' && port === ':443') || (scheme === 'http' && port === ':80')) port = '';
  return { host: host, origin: scheme + '://' + host + port, pathname: match[4] || '/', params: params };
}

function parseUrl(value) {
  const text = cleanText(value, MAX_URL_LENGTH);
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
  let parsed = null;
  if (typeof URL === 'function') {
    try {
      const url = new URL(withScheme);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      const params = {};
      url.searchParams.forEach(function (val, key) {
        const lowered = key.toLowerCase();
        if (!has(params, lowered)) params[lowered] = val;
      });
      parsed = { host: url.hostname.toLowerCase(), origin: url.origin, pathname: url.pathname || '/', params: params };
    } catch (error) {
      return null;
    }
  } else {
    parsed = parseUrlFallback(withScheme);
  }
  if (!parsed || parsed.host.indexOf('.') === -1) return null;
  return parsed;
}

function hostFromToken(token) {
  if (/^https?:\/\//.test(token) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/.test(token)) {
    const parsed = parseUrl(token);
    return parsed ? stripWww(parsed.host) : null;
  }
  return null;
}

function normalizeSource(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  if (has(SOURCE_ALIASES, token)) return SOURCE_ALIASES[token];
  const underscored = token.replace(/[\s-]+/g, '_');
  if (has(SOURCE_ALIASES, underscored)) return SOURCE_ALIASES[underscored];
  const host = hostFromToken(token);
  if (host) {
    const keys = Object.keys(SOURCE_ALIASES);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('.') !== -1 && hostMatches(host, keys[i])) return SOURCE_ALIASES[keys[i]];
    }
    if (GOOGLE_COUNTRY_HOST.test(host)) return 'google';
    return host;
  }
  return token;
}

function normalizeMedium(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  if (has(MEDIUM_ALIASES, token)) return MEDIUM_ALIASES[token];
  const underscored = token.replace(/[\s-]+/g, '_');
  if (has(MEDIUM_ALIASES, underscored)) return MEDIUM_ALIASES[underscored];
  return token;
}

function inferFromClickIds(tracking) {
  for (let i = 0; i < CLICK_ID_RULES.length; i++) {
    const rule = CLICK_ID_RULES[i];
    if (!isBlank(tracking[rule.param])) {
      return { source: rule.source, medium: rule.medium, clickIdType: rule.param };
    }
  }
  return null;
}

function classifyReferrer(referrerUrl, landingPageUrl, internalHosts) {
  const referrer = parseUrl(referrerUrl);
  if (!referrer) return null;
  const host = stripWww(referrer.host);
  const internal = (internalHosts || [])
    .map(function (entry) { return stripWww(String(entry).trim().toLowerCase()); })
    .filter(function (entry) { return entry.length > 0; });
  const landing = parseUrl(landingPageUrl);
  if (landing) internal.push(stripWww(landing.host));
  for (let i = 0; i < internal.length; i++) {
    // Internal navigation is not an acquisition source.
    if (hostMatches(host, internal[i])) return null;
  }
  if (GOOGLE_COUNTRY_HOST.test(host)) return { source: 'google', medium: 'organic_search' };
  const searchKeys = Object.keys(SEARCH_ENGINE_HOSTS);
  for (let i = 0; i < searchKeys.length; i++) {
    if (hostMatches(host, searchKeys[i])) return { source: SEARCH_ENGINE_HOSTS[searchKeys[i]], medium: 'organic_search' };
  }
  const socialKeys = Object.keys(SOCIAL_HOSTS);
  for (let i = 0; i < socialKeys.length; i++) {
    if (hostMatches(host, socialKeys[i])) return { source: SOCIAL_HOSTS[socialKeys[i]], medium: 'organic_social' };
  }
  return { source: host, medium: 'referral' };
}

function parseTimestamp(value) {
  if (isBlank(value)) return null;
  let ms;
  const text = String(value).trim();
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    ms = numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  } else {
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function utf8Bytes(text) {
  const bytes = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return bytes;
}

function fnv1a64(text) {
  // Pure-JS FNV-1a 64-bit so n8n needs no NODE_FUNCTION_ALLOW_BUILTIN=crypto.
  let hash = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  const mask = BigInt('0xffffffffffffffff');
  const bytes = utf8Bytes(String(text));
  for (let i = 0; i < bytes.length; i++) {
    hash = hash ^ BigInt(bytes[i]);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function extractProviderFields(raw) {
  const provider = normalizeToken(raw.provider);

  if (raw.event === 'invitee.created' || provider === 'calendly') {
    const payload = asObject(raw.payload);
    const scheduled = asObject(payload.scheduled_event);
    return {
      ingestion_source: 'calendly',
      email: payload.email,
      event_type: 'meeting_booked',
      converting_asset: pick(scheduled.name, payload.event_type_name, 'Calendly booking'),
      timestamp: pick(payload.created_at, raw.created_at),
      external_id: pick(payload.uri, payload.uuid),
      tracking: asObject(payload.tracking),
      landing_page_url: null,
      referrer_url: null
    };
  }

  if (provider === 'chili_piper' || provider === 'chilipiper') {
    const guest = asObject(raw.guest);
    const meeting = asObject(raw.meeting);
    return {
      ingestion_source: 'chili_piper',
      email: pick(guest.email, raw.email),
      event_type: 'meeting_booked',
      converting_asset: pick(meeting.type_name, meeting.name, raw.router_name, 'Chili Piper booking'),
      timestamp: pick(raw.booked_at, meeting.booked_at, raw.timestamp),
      external_id: pick(raw.meeting_id, meeting.id),
      tracking: asObject(raw.tracking),
      landing_page_url: pick(raw.page_url, raw.landing_page_url),
      referrer_url: pick(raw.referrer, raw.referrer_url)
    };
  }

  if (raw.type === 'user.signup' || provider === 'product' || provider === 'product_signup') {
    const data = asObject(raw.data);
    const user = asObject(data.user);
    const attribution = asObject(data.attribution);
    return {
      ingestion_source: 'product_signup',
      email: pick(user.email, raw.email),
      event_type: 'product_signup',
      converting_asset: pick(isBlank(data.plan) ? null : 'Product signup: ' + data.plan, data.signup_flow, 'Product signup'),
      timestamp: pick(raw.created_at, data.created_at, raw.timestamp),
      external_id: pick(raw.id),
      tracking: attribution,
      landing_page_url: pick(attribution.landing_page_url, attribution.landing_page),
      referrer_url: pick(attribution.referrer_url, attribution.referrer)
    };
  }

  if (provider === 'web_form' || !isBlank(raw.form_id) || (raw.fields && typeof raw.fields === 'object')) {
    const fields = lowerKeys(raw.fields);
    const context = asObject(raw.context);
    return {
      ingestion_source: 'web_form',
      email: pick(fields.email, raw.email),
      event_type: 'form_submission',
      converting_asset: pick(raw.form_name, isBlank(raw.form_id) ? null : 'Form ' + raw.form_id, 'Web form'),
      timestamp: pick(raw.submitted_at, raw.timestamp),
      external_id: pick(raw.submission_id),
      tracking: Object.assign({}, fields, context, asObject(context.utm)),
      landing_page_url: pick(context.page_url, raw.page_url, raw.landing_page_url),
      referrer_url: pick(context.referrer, raw.referrer, raw.referrer_url)
    };
  }

  return {
    ingestion_source: 'canonical',
    email: raw.email,
    event_type: raw.event_type,
    converting_asset: raw.converting_asset,
    timestamp: raw.timestamp,
    external_id: pick(raw.event_id, raw.idempotency_key),
    tracking: raw,
    landing_page_url: raw.landing_page_url,
    referrer_url: raw.referrer_url
  };
}

function normalizeEvent(raw, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['payload_must_be_a_json_object'], warnings: [], event: null };
  }

  const extracted = extractProviderFields(raw);
  const errors = [];
  const warnings = [];

  const email = normalizeToken(extracted.email);
  if (!email) errors.push('email_missing');
  else if (email.length > 254 || !EMAIL_PATTERN.test(email)) errors.push('email_invalid');

  const typeToken = normalizeToken(extracted.event_type);
  const typeKey = typeToken ? typeToken.replace(/[\s.-]+/g, '_') : null;
  const eventType = typeKey && has(EVENT_TYPE_ALIASES, typeKey) ? EVENT_TYPE_ALIASES[typeKey] : null;
  if (!typeToken) errors.push('event_type_missing');
  else if (!eventType) errors.push('event_type_unsupported:' + typeToken);

  let timestamp = parseTimestamp(extracted.timestamp);
  if (isBlank(extracted.timestamp)) {
    timestamp = now.toISOString();
    warnings.push('timestamp_missing_used_received_at');
  } else if (!timestamp) {
    errors.push('timestamp_invalid');
  } else if (Date.parse(timestamp) > now.getTime() + FUTURE_SKEW_MS) {
    errors.push('timestamp_in_future');
  }

  if (errors.length > 0) return { valid: false, errors: errors, warnings: warnings, event: null };

  const landingPageUrl = cleanText(extracted.landing_page_url, MAX_URL_LENGTH);
  const referrerUrl = cleanText(extracted.referrer_url, MAX_URL_LENGTH);
  const providedTracking = lowerKeys(extracted.tracking);
  const landing = parseUrl(landingPageUrl);
  const tracking = {};
  UTM_FIELDS.concat(CLICK_ID_FIELDS).forEach(function (field) {
    let value = cleanText(providedTracking[field]);
    if (!value && landing && !isBlank(landing.params[field])) value = cleanText(landing.params[field]);
    tracking[field] = value;
  });

  const explicitSource = normalizeSource(tracking.utm_source);
  const explicitMedium = normalizeMedium(tracking.utm_medium);
  const click = inferFromClickIds(tracking);
  const referral = classifyReferrer(referrerUrl, landingPageUrl, opts.internalHosts);

  let source;
  let medium;
  let method;
  if (explicitSource) {
    source = explicitSource;
    medium = explicitMedium || (click ? click.medium : 'unknown');
    method = 'utm';
  } else if (click) {
    source = click.source;
    medium = explicitMedium || click.medium;
    method = 'click_id';
  } else if (referral) {
    source = referral.source;
    medium = explicitMedium || referral.medium;
    method = 'referrer';
  } else if (explicitMedium) {
    source = 'unknown';
    medium = explicitMedium;
    method = 'utm_partial';
  } else {
    source = 'direct';
    medium = 'none';
    method = 'direct';
  }

  const convertingAsset = cleanText(extracted.converting_asset, MAX_ASSET_LENGTH) || eventType;
  const campaign = normalizeToken(tracking.utm_campaign);
  const externalId = cleanText(extracted.external_id, MAX_URL_LENGTH);
  const hashInput = externalId
    ? [extracted.ingestion_source, externalId].join('|')
    : [email, eventType, convertingAsset, timestamp, source, medium, campaign || ''].join('|');

  const event = {
    event_id: fnv1a64(hashInput),
    ingestion_source: extracted.ingestion_source,
    email: email,
    event_type: eventType,
    converting_asset: convertingAsset,
    timestamp: timestamp,
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
    utm_term: normalizeToken(tracking.utm_term),
    utm_content: normalizeToken(tracking.utm_content),
    gclid: tracking.gclid,
    gbraid: tracking.gbraid,
    wbraid: tracking.wbraid,
    msclkid: tracking.msclkid,
    li_fat_id: tracking.li_fat_id,
    fbclid: tracking.fbclid,
    click_id_type: click ? click.clickIdType : null,
    landing_page_url: landingPageUrl,
    referrer_url: referrerUrl,
    attribution_method: method
  };

  if (!externalId && warnings.indexOf('timestamp_missing_used_received_at') !== -1) {
    warnings.push('event_id_not_retry_stable_without_timestamp_or_external_id');
  }

  return { valid: true, errors: [], warnings: warnings, event: event };
}

function buildTouchpoint(event) {
  const landing = parseUrl(event.landing_page_url);
  const referrer = parseUrl(event.referrer_url);
  const touchpoint = {
    id: event.event_id,
    ts: event.timestamp,
    type: event.event_type,
    asset: event.converting_asset,
    source: event.utm_source,
    medium: event.utm_medium,
    campaign: event.utm_campaign,
    term: event.utm_term,
    content: event.utm_content,
    click_id: event.click_id_type,
    method: event.attribution_method,
    // Query strings and fragments are dropped on purpose: smaller history,
    // and no stray personal data from URLs lands in the CRM.
    landing_page: landing ? (landing.origin + landing.pathname).slice(0, MAX_HISTORY_URL_LENGTH) : null,
    referrer_host: referrer ? stripWww(referrer.host) : null
  };
  Object.keys(touchpoint).forEach(function (key) {
    if (touchpoint[key] === null || touchpoint[key] === undefined) delete touchpoint[key];
  });
  return touchpoint;
}

function parseHistory(rawValue) {
  if (isBlank(rawValue)) return { status: 'empty', entries: [] };
  let parsed;
  try {
    parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch (error) {
    return { status: 'corrupt', entries: [] };
  }
  if (!Array.isArray(parsed)) return { status: 'corrupt', entries: [] };
  const entries = parsed.filter(function (entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry) && !isBlank(entry.id);
  });
  return { status: entries.length === parsed.length ? 'ok' : 'sanitized', entries: entries };
}

function touchpointTime(entry) {
  const ms = Date.parse(entry.ts);
  return Number.isFinite(ms) ? ms : 0;
}

function appendTouchpoint(rawValue, touchpoint, options) {
  const opts = options || {};
  const maxTouchpoints = opts.maxTouchpoints || 25;
  const maxChars = opts.maxChars || 60000;
  const parsed = parseHistory(rawValue);

  if (parsed.status === 'corrupt') {
    return { status: 'corrupt', duplicate: false, changed: false, history: [], serialized: null, dropped: 0, retained: false };
  }

  const duplicate = parsed.entries.some(function (entry) { return entry.id === touchpoint.id; });
  if (duplicate) {
    return { status: parsed.status, duplicate: true, changed: false, history: parsed.entries, serialized: null, dropped: 0, retained: true };
  }

  const combined = parsed.entries.concat([touchpoint])
    .map(function (entry, index) { return { entry: entry, index: index }; })
    .sort(function (a, b) { return (touchpointTime(a.entry) - touchpointTime(b.entry)) || (a.index - b.index); })
    .map(function (wrapped) { return wrapped.entry; });

  let history = combined.length > maxTouchpoints ? combined.slice(combined.length - maxTouchpoints) : combined;
  let serialized = JSON.stringify(history);
  while (serialized.length > maxChars && history.length > 1) {
    history = history.slice(1);
    serialized = JSON.stringify(history);
  }
  if (serialized.length > maxChars) {
    return { status: 'oversize', duplicate: false, changed: false, history: parsed.entries, serialized: null, dropped: 0, retained: false };
  }

  return {
    status: parsed.status,
    duplicate: false,
    changed: serialized !== JSON.stringify(parsed.entries),
    history: history,
    serialized: serialized,
    dropped: combined.length - history.length,
    retained: history.some(function (entry) { return entry.id === touchpoint.id; })
  };
}
// </n8n-core:normalizer>

module.exports = {
  CANONICAL_EVENT_TYPES,
  UTM_FIELDS,
  CLICK_ID_FIELDS,
  EVENT_TYPE_ALIASES,
  SOURCE_ALIASES,
  MEDIUM_ALIASES,
  CLICK_ID_RULES,
  SEARCH_ENGINE_HOSTS,
  SOCIAL_HOSTS,
  isBlank,
  cleanText,
  normalizeToken,
  normalizeSource,
  normalizeMedium,
  parseUrl,
  parseUrlFallback,
  inferFromClickIds,
  classifyReferrer,
  parseTimestamp,
  fnv1a64,
  extractProviderFields,
  normalizeEvent,
  buildTouchpoint,
  parseHistory,
  appendTouchpoint
};
