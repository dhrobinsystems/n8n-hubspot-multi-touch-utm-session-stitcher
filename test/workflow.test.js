'use strict';

/**
 * workflow.test.js
 *
 * Run with: npm test   (node --test, zero dependencies)
 *
 * Coverage map:
 *   1. Config fail-safe defaults and write gates
 *   2. UTM normalization, aliasing, click-ID and referrer fallback
 *   3. Provider adapters and validation
 *   4. Touchpoint history dedupe, ordering, and capping
 *   5. First-Touch immutability and Last-Touch rules
 *   6. Engine end-to-end against an in-memory HubSpot fake (dry run, sandbox
 *      gate, two-pass 409 upsert, 429 retry, webhook signatures)
 *   7. workflow.json structure, write-gate topology, and Code-node parity
 *   8. Repository security scan (secrets, private keys, non-RFC-2606 domains)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const config = require('../src/config');
const normalizer = require('../src/normalizer');
const mapper = require('../src/hubspot-mapper');
const engine = require('../src/index');
const builder = require('../scripts/build-workflow');

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'conversion-events-batch.json'), 'utf8'));
const NOW = new Date('2026-11-14T12:00:00.000Z');

function fixture(id) {
  const entry = FIXTURES.events.find(function (e) { return e.fixture_id === id; });
  if (!entry) throw new Error('Unknown fixture ' + id);
  return JSON.parse(JSON.stringify(entry.payload));
}

function normalized(id, opts) {
  const result = normalizer.normalizeEvent(fixture(id), Object.assign({ now: NOW }, opts || {}));
  assert.equal(result.valid, true, 'fixture ' + id + ' should be valid: ' + JSON.stringify(result.errors));
  return result.event;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// In-memory HubSpot fake
// ---------------------------------------------------------------------------

function createFakeHubSpot(options) {
  const opts = Object.assign({ accountType: 'DEVELOPER_TEST', portalId: 1001, searchLag: false, rateLimitFirst: 0 }, options || {});
  const contacts = new Map();
  const indexed = new Set();
  const calls = [];
  let nextId = 5001;
  let rateLimitRemaining = opts.rateLimitFirst;

  function respond(status, payload, headers) {
    const h = headers || {};
    return {
      status: status,
      headers: { get: function (key) { return h[String(key).toLowerCase()] === undefined ? null : h[String(key).toLowerCase()]; } },
      text: async function () { return payload === undefined ? '' : JSON.stringify(payload); }
    };
  }

  function readView(contact, wanted) {
    const view = {};
    (wanted || Object.keys(contact.properties)).forEach(function (key) {
      let value = contact.properties[key];
      if ((key === 'ft_timestamp' || key === 'lt_timestamp') && value && /^\d+$/.test(value)) {
        value = new Date(Number(value)).toISOString(); // HubSpot returns datetimes as ISO
      }
      view[key] = value === undefined || value === '' ? null : value;
    });
    return view;
  }

  async function fetchImpl(url, init) {
    const u = new URL(url);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: method, path: u.pathname, body: body, auth: init.headers.Authorization });

    if (rateLimitRemaining > 0) {
      rateLimitRemaining--;
      return respond(429, { status: 'error', message: 'Rate limit' }, { 'retry-after': '1' });
    }
    if (method === 'GET' && u.pathname === '/account-info/v3/details') {
      return respond(200, { portalId: opts.portalId, accountType: opts.accountType });
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/contacts/search') {
      const email = body.filterGroups[0].filters[0].value;
      const found = Array.from(contacts.values()).find(function (c) {
        return c.properties.email === email && (!opts.searchLag || indexed.has(c.id));
      });
      return respond(200, { total: found ? 1 : 0, results: found ? [{ id: found.id, properties: readView(found, body.properties) }] : [] });
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/contacts') {
      const existing = Array.from(contacts.values()).find(function (c) { return c.properties.email === body.properties.email; });
      if (existing) return respond(409, { status: 'error', category: 'CONFLICT', message: 'Contact already exists. Existing ID: ' + existing.id });
      const id = String(nextId++);
      contacts.set(id, { id: id, properties: Object.assign({}, body.properties) });
      return respond(201, { id: id, properties: body.properties });
    }
    const match = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(u.pathname);
    if (match && method === 'GET') {
      const contact = contacts.get(match[1]);
      if (!contact) return respond(404, { status: 'error', message: 'Not found' });
      const wanted = (u.searchParams.get('properties') || '').split(',').filter(Boolean);
      return respond(200, { id: contact.id, properties: readView(contact, wanted.length ? wanted : null) });
    }
    if (match && method === 'PATCH') {
      const contact = contacts.get(match[1]);
      if (!contact) return respond(404, { status: 'error', message: 'Not found' });
      Object.assign(contact.properties, body.properties);
      return respond(200, { id: contact.id, properties: contact.properties });
    }
    return respond(404, { status: 'error', message: 'Unhandled ' + method + ' ' + u.pathname });
  }

  return {
    fetchImpl: fetchImpl,
    contacts: contacts,
    calls: calls,
    seed: function (props) {
      const id = String(nextId++);
      contacts.set(id, { id: id, properties: Object.assign({}, props) });
      indexed.add(id);
      return id;
    },
    index: function (id) { indexed.add(id); },
    byEmail: function (email) { return Array.from(contacts.values()).find(function (c) { return c.properties.email === email; }); },
    writeCalls: function () { return calls.filter(function (c) { return c.method === 'PATCH' || (c.method === 'POST' && c.path === '/crm/v3/objects/contacts'); }); }
  };
}

function sandboxConfig(extra) {
  return config.loadConfig(Object.assign({
    DRY_RUN: 'false',
    SANDBOX_MODE: 'true',
    HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'test-token'
  }, extra || {}));
}

function clientFor(fake) {
  return new engine.HubSpotClient({ token: 'test-token', fetchImpl: fake.fetchImpl, sleep: async function () {}, baseDelayMs: 1 });
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

test('config: DRY_RUN and SANDBOX_MODE default to true with an empty environment', function () {
  const cfg = config.loadConfig({});
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.sandboxMode, true);
  assert.equal(cfg.writeMode, 'dry_run');
  assert.equal(cfg.allowProductionWrites, false);
  assert.equal(cfg.maxTouchpoints, 25);
  assert.equal(cfg.hubspotBaseUrl, 'https://api.hubapi.com');
  assert.ok(Object.isFrozen(cfg));
});

test('config: only the literal string "false" disables a safety flag', function () {
  ['0', 'no', 'off', 'False-ish', '', 'flase'].forEach(function (value) {
    assert.equal(config.loadConfig({ DRY_RUN: value }).dryRun, true, 'DRY_RUN=' + value + ' must stay true');
  });
  assert.equal(config.parseConfig({ DRY_RUN: ' FALSE ' }).dryRun, false);
});

test('config: production writes need a third explicit opt-in', function () {
  assert.throws(function () { config.parseConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_WRITES/);
  const cfg = config.parseConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false', ALLOW_PRODUCTION_WRITES: 'true' });
  assert.equal(cfg.writeMode, 'production');
});

test('config: write modes refuse placeholder or empty tokens', function () {
  assert.throws(function () {
    config.loadConfig({ DRY_RUN: 'false', HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'REPLACE_WITH_HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN' });
  }, /placeholder/);
  assert.throws(function () { config.loadConfig({ DRY_RUN: 'false' }); }, /HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN/);
});

test('config: sandbox mode never reads the production token', function () {
  const cfg = config.loadConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'prod-token', HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'sbx-token' });
  assert.equal(cfg.hubspotToken, 'sbx-token');
  assert.equal(cfg.hubspotTokenVar, 'HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN');
  assert.equal(config.describeConfig(cfg).hubspotToken, '[redacted]');
});

test('config: numeric bounds and enums are validated', function () {
  assert.throws(function () { config.parseConfig({ MAX_TOUCHPOINTS: '0' }); }, /MAX_TOUCHPOINTS/);
  assert.throws(function () { config.parseConfig({ MAX_HISTORY_CHARS: '70000' }); }, /MAX_HISTORY_CHARS/);
  assert.throws(function () { config.parseConfig({ HISTORY_CORRUPT_STRATEGY: 'wipe' }); }, /HISTORY_CORRUPT_STRATEGY/);
  assert.throws(function () { config.parseConfig({ HUBSPOT_BASE_URL: 'http://api.example.com' }); }, /https/);
  assert.deepEqual(config.parseConfig({ INTERNAL_HOSTS: ' Example.com, app.example.org ,' }).internalHosts, ['example.com', 'app.example.org']);
});

test('config: write-target gate only allows sandbox or developer test portals in sandbox mode', function () {
  const cfg = config.parseConfig({ DRY_RUN: 'false' });
  assert.equal(config.evaluateWriteTarget(cfg, { accountType: 'STANDARD', portalId: 1001 }).allowed, false);
  assert.equal(config.evaluateWriteTarget(cfg, { accountType: 'SANDBOX', portalId: 1001 }).allowed, true);
  assert.equal(config.evaluateWriteTarget(cfg, { accountType: 'DEVELOPER_TEST', portalId: 1001 }).allowed, true);
  const pinned = config.parseConfig({ DRY_RUN: 'false', HUBSPOT_SANDBOX_PORTAL_ID: '2002' });
  assert.equal(config.evaluateWriteTarget(pinned, { accountType: 'SANDBOX', portalId: 1001 }).reason, 'sandbox_portal_id_mismatch');
  assert.equal(config.evaluateWriteTarget(config.parseConfig({}), {}).allowed, false);
});

// ---------------------------------------------------------------------------
// 2. UTM normalization and inference
// ---------------------------------------------------------------------------

test('normalizer: lowercases, trims, and collapses whitespace', function () {
  assert.equal(normalizer.normalizeToken('  Spring_Launch   2026 '), 'spring_launch 2026');
  assert.equal(normalizer.normalizeToken('   '), null);
  assert.equal(normalizer.normalizeToken(null), null);
});

test('normalizer: source aliasing is deterministic', function () {
  const cases = {
    fb: 'facebook', ' FB ': 'facebook', 'facebook.com': 'facebook', 'https://m.facebook.com/': 'facebook',
    ig: 'instagram', 'l.instagram.com': 'instagram', 'linkedin.com': 'linkedin', 'LinkedIn.com': 'linkedin',
    'www.linkedin.com': 'linkedin', 'lnkd.in': 'linkedin', 'google-ads': 'google', 'google.co.uk': 'google',
    't.co': 'x', twitter: 'x', 'e-mail': 'email', 'email-newsletter': 'email', newsletter: 'newsletter',
    'partner.example.com': 'partner.example.com', constructor: 'constructor'
  };
  Object.keys(cases).forEach(function (input) {
    assert.equal(normalizer.normalizeSource(input), cases[input], 'source ' + JSON.stringify(input));
  });
});

test('normalizer: medium aliasing is deterministic', function () {
  const cases = {
    cpc: 'paid_search', PPC: 'paid_search', paidsearch: 'paid_search', 'Paid Search': 'paid_search',
    'Paid-Social': 'paid_social', paidsocial: 'paid_social', 'email-newsletter': 'email', 'E-Mail': 'email',
    newsletter: 'email', social: 'organic_social', organic: 'organic_search', banner: 'display',
    '(none)': 'none', webinar: 'webinar', constructor: 'constructor', toString: 'tostring'
  };
  Object.keys(cases).forEach(function (input) {
    assert.equal(normalizer.normalizeMedium(input), cases[input], 'medium ' + JSON.stringify(input));
  });
});

test('normalizer: click IDs infer source and medium when UTMs are missing', function () {
  const base = { email: 'pat.doe@example.com', event_type: 'form_submission', timestamp: '2026-10-01T00:00:00Z' };
  const gclid = normalizer.normalizeEvent(Object.assign({ gclid: 'TEST-1' }, base), { now: NOW }).event;
  assert.deepEqual([gclid.utm_source, gclid.utm_medium, gclid.attribution_method, gclid.click_id_type], ['google', 'paid_search', 'click_id', 'gclid']);
  const li = normalizer.normalizeEvent(Object.assign({ li_fat_id: 'TEST-2' }, base), { now: NOW }).event;
  assert.deepEqual([li.utm_source, li.utm_medium], ['linkedin', 'paid_social']);
  const fb = normalizer.normalizeEvent(Object.assign({ fbclid: 'TEST-3' }, base), { now: NOW }).event;
  assert.deepEqual([fb.utm_source, fb.utm_medium], ['facebook', 'paid_social']);
  const both = normalizer.normalizeEvent(Object.assign({ fbclid: 'TEST-3', gclid: 'TEST-1' }, base), { now: NOW }).event;
  assert.equal(both.utm_source, 'google', 'gclid takes precedence over fbclid');
});

test('normalizer: explicit UTMs beat click IDs, and click IDs fill a missing medium', function () {
  const event = normalizer.normalizeEvent({
    email: 'pat.doe@example.com', event_type: 'form_submission', timestamp: '2026-10-01T00:00:00Z',
    utm_source: 'Google', gclid: 'TEST-1'
  }, { now: NOW }).event;
  assert.deepEqual([event.utm_source, event.utm_medium, event.attribution_method], ['google', 'paid_search', 'utm']);
});

test('normalizer: referrer fallback classifies search, social, referral, and internal traffic', function () {
  const landing = 'https://www.example.com/pricing';
  assert.deepEqual(normalizer.classifyReferrer('https://www.google.com/', landing), { source: 'google', medium: 'organic_search' });
  assert.deepEqual(normalizer.classifyReferrer('https://www.google.co.uk/search', landing), { source: 'google', medium: 'organic_search' });
  assert.deepEqual(normalizer.classifyReferrer('https://duckduckgo.com/', landing), { source: 'duckduckgo', medium: 'organic_search' });
  assert.deepEqual(normalizer.classifyReferrer('https://www.linkedin.com/feed/', landing), { source: 'linkedin', medium: 'organic_social' });
  assert.deepEqual(normalizer.classifyReferrer('https://blog.example.org/post', landing), { source: 'blog.example.org', medium: 'referral' });
  assert.equal(normalizer.classifyReferrer('https://example.com/blog', landing), null, 'same site is internal');
  assert.equal(normalizer.classifyReferrer('https://docs.example.net/', landing, ['example.net']), null, 'configured internal host');
  assert.equal(normalizer.classifyReferrer('not a url', landing), null);
});

test('normalizer: no UTMs, click IDs, or external referrer defaults cleanly to direct / none', function () {
  const event = normalized('form-submit-direct-within-window');
  assert.deepEqual([event.utm_source, event.utm_medium, event.attribution_method], ['direct', 'none', 'direct']);
  assert.equal(event.utm_campaign, null);
});

test('normalizer: UTMs are recovered from the landing page query string', function () {
  const event = normalized('form-submit-paid-search-after-window');
  assert.deepEqual(
    [event.utm_source, event.utm_medium, event.utm_campaign, event.utm_term],
    ['google', 'paid_search', 'competitor-terms', 'attribution software']
  );
});

test('normalizer: pure-JS URL fallback matches the WHATWG URL parser', function () {
  [
    'https://www.example.com/pricing?gclid=TEST-GCLID-1001&utm_campaign=Brand_Search',
    'https://app.example.com:8443/signup?UTM_Source=Mixed%20Case&x=1#frag',
    'http://example.org/?a=1&a=2&b=%E2%9C%93'
  ].forEach(function (url) {
    const native = normalizer.parseUrl(url);
    const fallback = normalizer.parseUrlFallback(url);
    assert.deepEqual(plain(fallback), plain(native), url);
  });
});

// ---------------------------------------------------------------------------
// 3. Adapters and validation
// ---------------------------------------------------------------------------

test('adapters: web form, Calendly, Chili Piper, and product signup map to the canonical schema', function () {
  const form = normalized('form-submit-paid-social-aliasing');
  assert.deepEqual(
    [form.ingestion_source, form.email, form.event_type, form.converting_asset, form.utm_source, form.utm_medium, form.utm_campaign, form.utm_content],
    ['web_form', 'alex.rivera@example.com', 'form_submission', 'Demo Request', 'facebook', 'paid_social', 'spring_launch_2026', 'carousel-a']
  );
  const calendly = normalized('calendly-booking-linkedin-alias');
  assert.deepEqual(
    [calendly.ingestion_source, calendly.event_type, calendly.converting_asset, calendly.utm_source, calendly.utm_medium],
    ['calendly', 'meeting_booked', '30-Minute Discovery Call', 'linkedin', 'paid_social']
  );
  const chili = normalized('chili-piper-gclid-only');
  assert.deepEqual(
    [chili.ingestion_source, chili.utm_source, chili.utm_medium, chili.utm_campaign, chili.gclid],
    ['chili_piper', 'google', 'paid_search', 'brand_search', 'TEST-GCLID-1001']
  );
  const signup = normalized('product-signup-linkedin-click-id');
  assert.deepEqual(
    [signup.ingestion_source, signup.event_type, signup.converting_asset, signup.utm_source, signup.utm_medium],
    ['product_signup', 'product_signup', 'Product signup: Starter', 'linkedin', 'paid_social']
  );
  const organic = normalized('product-signup-organic-referrer');
  assert.deepEqual([organic.utm_source, organic.utm_medium, organic.timestamp], ['google', 'organic_search', new Date(1791360000 * 1000).toISOString()]);
  const canonical = normalized('canonical-email-newsletter-aliasing');
  assert.deepEqual([canonical.event_type, canonical.utm_source, canonical.utm_medium], ['form_submission', 'newsletter', 'email']);
});

test('validation: rejects bad emails, unknown event types, bad and future timestamps, and arrays', function () {
  assert.deepEqual(normalizer.normalizeEvent(fixture('invalid-email-rejected'), { now: NOW }).errors, ['email_invalid']);
  const base = { email: 'pat.doe@example.com', event_type: 'form_submission', timestamp: '2026-10-01T00:00:00Z' };
  assert.deepEqual(normalizer.normalizeEvent(Object.assign({}, base, { event_type: 'page_view' }), { now: NOW }).errors, ['event_type_unsupported:page_view']);
  assert.deepEqual(normalizer.normalizeEvent(Object.assign({}, base, { timestamp: 'yesterday-ish' }), { now: NOW }).errors, ['timestamp_invalid']);
  assert.deepEqual(normalizer.normalizeEvent(Object.assign({}, base, { timestamp: '2027-01-01T00:00:00Z' }), { now: NOW }).errors, ['timestamp_in_future']);
  assert.deepEqual(normalizer.normalizeEvent([base], { now: NOW }).errors, ['payload_must_be_a_json_object']);
  const missing = normalizer.normalizeEvent({ email: 'pat.doe@example.com', event_type: 'signup' }, { now: NOW });
  assert.equal(missing.valid, true);
  assert.ok(missing.warnings.includes('timestamp_missing_used_received_at'));
  assert.ok(missing.warnings.includes('event_id_not_retry_stable_without_timestamp_or_external_id'));
});

test('hashing: FNV-1a 64 matches published vectors and event IDs are retry-stable', function () {
  assert.equal(normalizer.fnv1a64(''), 'cbf29ce484222325');
  assert.equal(normalizer.fnv1a64('a'), 'af63dc4c8601ec8c');
  assert.equal(normalizer.fnv1a64('foobar'), '85944171f73967e8');
  assert.equal(normalized('form-submit-paid-social-aliasing').event_id, normalized('form-submit-duplicate-retry').event_id);
  assert.notEqual(normalized('form-submit-paid-social-aliasing').event_id, normalized('form-submit-direct-within-window').event_id);
});

test('touchpoint: strips query strings and keeps only the referrer host', function () {
  const tp = normalizer.buildTouchpoint(normalized('form-submit-paid-social-aliasing'));
  assert.equal(tp.landing_page, 'https://www.example.com/demo');
  assert.equal(tp.referrer_host, 'l.facebook.com');
  assert.equal(tp.source, 'facebook');
  assert.equal('term' in tp, false, 'null fields are omitted to save characters');
});

// ---------------------------------------------------------------------------
// 4. Touchpoint history
// ---------------------------------------------------------------------------

function tp(n, iso) {
  return { id: 'tp' + String(n).padStart(4, '0'), ts: iso || new Date(Date.UTC(2026, 0, 1) + n * 3600000).toISOString(), source: 'google', medium: 'paid_search' };
}

test('history: appends to empty and parses existing arrays', function () {
  const first = normalizer.appendTouchpoint(null, tp(1));
  assert.equal(first.changed, true);
  assert.equal(JSON.parse(first.serialized).length, 1);
  const second = normalizer.appendTouchpoint(first.serialized, tp(2));
  assert.deepEqual(JSON.parse(second.serialized).map(function (e) { return e.id; }), ['tp0001', 'tp0002']);
});

test('history: duplicate event IDs are detected so retries never double-count', function () {
  const existing = JSON.stringify([tp(1), tp(2)]);
  const result = normalizer.appendTouchpoint(existing, tp(2));
  assert.equal(result.duplicate, true);
  assert.equal(result.changed, false);
});

test('history: late events are inserted in timestamp order', function () {
  const existing = JSON.stringify([tp(1), tp(5)]);
  const result = normalizer.appendTouchpoint(existing, tp(3));
  assert.deepEqual(JSON.parse(result.serialized).map(function (e) { return e.id; }), ['tp0001', 'tp0003', 'tp0005']);
});

test('history: enforces the touchpoint cap by dropping the oldest entries', function () {
  const existing = JSON.stringify(Array.from({ length: 25 }, function (_, i) { return tp(i + 1); }));
  const result = normalizer.appendTouchpoint(existing, tp(26), { maxTouchpoints: 25 });
  const ids = JSON.parse(result.serialized).map(function (e) { return e.id; });
  assert.equal(ids.length, 25);
  assert.equal(ids[0], 'tp0002');
  assert.equal(ids[24], 'tp0026');
  assert.equal(result.dropped, 1);
});

test('history: an event older than a full capped window leaves history unchanged', function () {
  const existing = JSON.stringify(Array.from({ length: 3 }, function (_, i) { return tp(i + 10); }));
  const result = normalizer.appendTouchpoint(existing, tp(1), { maxTouchpoints: 3 });
  assert.equal(result.changed, false);
  assert.equal(result.retained, false);
});

test('history: enforces the character budget for HubSpot text properties', function () {
  const big = Array.from({ length: 40 }, function (_, i) { return Object.assign(tp(i + 1), { asset: 'x'.repeat(150) }); });
  const result = normalizer.appendTouchpoint(JSON.stringify(big), tp(100), { maxTouchpoints: 200, maxChars: 2000 });
  assert.ok(result.serialized.length <= 2000);
  assert.equal(JSON.parse(result.serialized).slice(-1)[0].id, 'tp0100');
});

test('history: corrupt JSON and non-arrays are reported, invalid entries are sanitized', function () {
  assert.equal(normalizer.appendTouchpoint('{not json', tp(1)).status, 'corrupt');
  assert.equal(normalizer.appendTouchpoint('{"a":1}', tp(1)).status, 'corrupt');
  const sanitized = normalizer.appendTouchpoint(JSON.stringify([tp(1), 'junk', { no: 'id' }]), tp(2));
  assert.equal(sanitized.status, 'sanitized');
  assert.equal(JSON.parse(sanitized.serialized).length, 2);
});

// ---------------------------------------------------------------------------
// 5. First-Touch / Last-Touch mapping
// ---------------------------------------------------------------------------

function plan(existingProps, fixtureId, options) {
  const event = normalized(fixtureId);
  return mapper.buildContactWrite({
    existing: existingProps ? { id: '5001', properties: existingProps } : null,
    event: event,
    touchpoint: normalizer.buildTouchpoint(event),
    options: options
  });
}

test('mapper: new contact gets First Touch, Last Touch, email, and history', function () {
  const result = plan(null, 'form-submit-paid-social-aliasing');
  assert.equal(result.action, 'create');
  const p = result.properties;
  assert.equal(p.email, 'alex.rivera@example.com');
  assert.deepEqual([p.ft_utm_source, p.ft_utm_medium, p.ft_utm_campaign, p.ft_converting_asset], ['facebook', 'paid_social', 'spring_launch_2026', 'Demo Request']);
  assert.equal(p.ft_timestamp, String(Date.parse('2026-10-01T09:15:00.000Z')));
  assert.deepEqual([p.lt_utm_source, p.lt_utm_medium, p.latest_converting_asset], ['facebook', 'paid_social', 'Demo Request']);
  assert.equal(JSON.parse(p.utm_touchpoint_history).length, 1);
});

test('mapper: First Touch is immutable once ft_timestamp exists', function () {
  const existing = {
    email: 'alex.rivera@example.com',
    ft_utm_source: 'facebook', ft_utm_medium: 'paid_social', ft_utm_campaign: 'spring_launch_2026',
    ft_converting_asset: 'Demo Request', ft_timestamp: '2026-10-01T09:15:00.000Z',
    lt_utm_source: 'facebook', lt_utm_medium: 'paid_social', lt_timestamp: '2026-10-01T09:15:00.000Z'
  };
  const result = plan(existing, 'calendly-booking-linkedin-alias');
  assert.equal(result.decisions.firstTouch, 'preserved');
  Object.keys(result.properties).forEach(function (key) { assert.ok(!key.startsWith('ft_'), key + ' must not be written'); });
  assert.deepEqual([result.properties.lt_utm_source, result.properties.lt_utm_campaign, result.properties.latest_converting_asset], ['linkedin', 'q4-abm-retarget', '30-Minute Discovery Call']);
});

test('mapper: an older event arriving late never rewrites First Touch', function () {
  const result = plan({ ft_utm_source: 'linkedin', ft_timestamp: '2026-10-30T00:00:00.000Z' }, 'form-submit-paid-social-aliasing');
  assert.equal(result.decisions.firstTouch, 'preserved');
  assert.ok(result.warnings.includes('event_older_than_existing_first_touch_not_overwritten'));
  assert.equal(result.properties.ft_utm_source, undefined);
});

test('mapper: First Touch populates when ft_timestamp is empty even if other ft_ fields exist', function () {
  const result = plan({ ft_utm_source: 'manual-entry', ft_timestamp: '' }, 'calendly-booking-linkedin-alias');
  assert.equal(result.decisions.firstTouch, 'set');
  assert.equal(result.properties.ft_utm_source, 'linkedin');
});

test('mapper: Last Touch is not overwritten by a stale out-of-order event', function () {
  const result = plan({ ft_timestamp: '2026-09-01T00:00:00Z', lt_utm_source: 'google', lt_timestamp: '2026-10-30T00:00:00Z' }, 'calendly-booking-linkedin-alias');
  assert.equal(result.decisions.lastTouch, 'stale_event_not_applied');
  assert.equal(result.properties.lt_utm_source, undefined);
  assert.equal(result.properties.latest_converting_asset, undefined);
  assert.ok(result.properties.utm_touchpoint_history, 'history still records the late touch');
});

test('mapper: direct / none does not replace a known source inside the attribution window', function () {
  const existing = { ft_timestamp: '2026-10-01T09:15:00Z', lt_utm_source: 'linkedin', lt_utm_medium: 'paid_social', lt_utm_campaign: 'q4-abm-retarget', lt_timestamp: '2026-10-05T14:30:00Z' };
  const result = plan(existing, 'form-submit-direct-within-window');
  assert.equal(result.decisions.lastTouch, 'protected_known_source_within_window');
  assert.equal(result.properties.lt_utm_source, undefined);
  assert.equal(result.properties.lt_timestamp, undefined);
  assert.equal(result.properties.latest_converting_asset, 'Pricing Question');
});

test('mapper: direct / none does overwrite outside the window or when protection is off', function () {
  const existing = { ft_timestamp: '2026-08-01T00:00:00Z', lt_utm_source: 'linkedin', lt_utm_medium: 'paid_social', lt_timestamp: '2026-08-01T00:00:00Z' };
  assert.equal(plan(existing, 'form-submit-direct-within-window').properties.lt_utm_source, 'direct');
  const recent = Object.assign({}, existing, { lt_timestamp: '2026-10-10T00:00:00Z' });
  assert.equal(plan(recent, 'form-submit-direct-within-window', { protectLastTouchFromDirect: false }).properties.lt_utm_source, 'direct');
  assert.equal(plan(recent, 'form-submit-direct-within-window', { attributionWindowDays: 0 }).properties.lt_utm_source, 'direct');
});

test('mapper: Last Touch clears a stale campaign when the new session has none', function () {
  const existing = { ft_timestamp: '2026-09-01T00:00:00Z', lt_utm_source: 'linkedin', lt_utm_medium: 'paid_social', lt_utm_campaign: 'old-campaign', lt_timestamp: '2026-09-01T00:00:00Z' };
  const result = plan(existing, 'product-signup-linkedin-click-id');
  assert.equal(result.properties.lt_utm_campaign, '');
});

test('mapper: duplicate events produce a no-op skip', function () {
  const first = plan(null, 'form-submit-paid-social-aliasing');
  const stored = Object.assign({}, first.properties, { ft_timestamp: '2026-10-01T09:15:00.000Z', lt_timestamp: '2026-10-01T09:15:00.000Z' });
  const retry = plan(stored, 'form-submit-duplicate-retry');
  assert.equal(retry.action, 'skip');
  assert.equal(retry.reason, 'duplicate_event');
  assert.deepEqual(retry.properties, {});
});

test('mapper: corrupt history is preserved by default and reset only on request', function () {
  const existing = { ft_timestamp: '2026-09-01T00:00:00Z', utm_touchpoint_history: '[{"id":"broken"' };
  const preserved = plan(existing, 'calendly-booking-linkedin-alias');
  assert.equal(preserved.properties.utm_touchpoint_history, undefined);
  assert.ok(preserved.warnings.includes('history_corrupt_preserved_not_written'));
  const reset = plan(existing, 'calendly-booking-linkedin-alias', { historyCorruptStrategy: 'reset' });
  assert.equal(JSON.parse(reset.properties.utm_touchpoint_history).length, 1);
});

test('mapper: parses the existing contact ID from a 409 conflict body', function () {
  assert.equal(mapper.parseExistingIdFromConflict({ message: 'Contact already exists. Existing ID: 5001' }), '5001');
  assert.equal(mapper.parseExistingIdFromConflict({ message: 'Something else' }), null);
  assert.equal(mapper.parseExistingIdFromConflict(null), null);
});

// ---------------------------------------------------------------------------
// 6. Engine end-to-end
// ---------------------------------------------------------------------------

test('engine: default dry run never sends a write request', async function () {
  const fake = createFakeHubSpot();
  const cfg = config.loadConfig({ HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'test-token' });
  const events = FIXTURES.events.map(function (e) { return e.payload; });
  const results = await engine.processBatch(events, { config: cfg, client: clientFor(fake), now: function () { return NOW; } });
  assert.equal(fake.writeCalls().length, 0);
  assert.ok(fake.calls.length > 0, 'read-only lookups still run');
  assert.ok(results.every(function (r) { return ['dry_run', 'rejected', 'skipped'].includes(r.status); }));
});

test('engine: dry run without any client still produces previews', async function () {
  const cfg = config.loadConfig({});
  const result = await engine.processEvent(fixture('chili-piper-gclid-only'), { config: cfg, now: function () { return NOW; } });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.plan.properties.ft_utm_source, 'google');
  assert.ok(result.warnings.includes('lookup_skipped_in_dry_run_assumed_new_contact'));
});

test('engine: sandbox gate blocks writes to a STANDARD (production) portal', async function () {
  const fake = createFakeHubSpot({ accountType: 'STANDARD' });
  await assert.rejects(
    engine.processEvent(fixture('chili-piper-gclid-only'), { config: sandboxConfig(), client: clientFor(fake), now: function () { return NOW; } }),
    function (error) { return error instanceof engine.WriteGateError; }
  );
  assert.equal(fake.writeCalls().length, 0);
});

test('engine: full batch against a sandbox stitches First and Last Touch correctly', async function () {
  const fake = createFakeHubSpot();
  const events = FIXTURES.events.map(function (e) { return e.payload; });
  const results = await engine.processBatch(events, { config: sandboxConfig(), client: clientFor(fake), now: function () { return NOW; } });
  const statuses = results.map(function (r) { return r.status; });
  assert.deepEqual(statuses, ['created', 'updated', 'updated', 'skipped', 'created', 'created', 'created', 'updated', 'updated', 'rejected']);

  const alex = fake.byEmail('alex.rivera@example.com').properties;
  assert.deepEqual([alex.ft_utm_source, alex.ft_utm_medium, alex.ft_converting_asset], ['facebook', 'paid_social', 'Demo Request']);
  assert.deepEqual([alex.lt_utm_source, alex.lt_utm_medium, alex.lt_utm_campaign], ['google', 'paid_search', 'competitor-terms']);
  assert.equal(alex.latest_converting_asset, 'Contact Sales');
  const history = JSON.parse(alex.utm_touchpoint_history);
  assert.equal(history.length, 4, 'four unique touches, the retry is deduped');
  assert.deepEqual(history.map(function (h) { return h.source; }), ['facebook', 'linkedin', 'direct', 'google']);

  const jordan = fake.byEmail('jordan.lee@example.org').properties;
  assert.equal(jordan.ft_utm_source, 'google');
  assert.equal(jordan.lt_utm_medium, 'email');
});

test('engine: two-pass upsert re-fetches on 409 and keeps First Touch immutable', async function () {
  const fake = createFakeHubSpot({ searchLag: true });
  fake.contacts.set('7001', {
    id: '7001',
    properties: { email: 'sam.patel@example.net', ft_utm_source: 'partner.example.org', ft_utm_medium: 'referral', ft_timestamp: String(Date.parse('2026-09-01T00:00:00Z')) }
  }); // exists, but not yet visible to search
  const result = await engine.processEvent(fixture('product-signup-linkedin-click-id'), { config: sandboxConfig(), client: clientFor(fake), now: function () { return NOW; } });
  assert.equal(result.status, 'updated');
  assert.equal(result.pass, 2);
  assert.equal(result.contactId, '7001');
  const props = fake.contacts.get('7001').properties;
  assert.equal(props.ft_utm_source, 'partner.example.org');
  assert.equal(props.lt_utm_source, 'linkedin');
  const paths = fake.calls.map(function (c) { return c.method + ' ' + c.path; });
  assert.ok(paths.includes('GET /crm/v3/objects/contacts/7001'));
});

test('engine: lookup failure aborts write mode instead of risking a duplicate create', async function () {
  const failing = async function () { return { status: 401, headers: { get: function () { return null; } }, text: async function () { return '{"message":"Unauthorized"}'; } }; };
  const client = new engine.HubSpotClient({ token: 'test-token', fetchImpl: failing, sleep: async function () {} });
  await assert.rejects(engine.processEvent(fixture('chili-piper-gclid-only'), { config: sandboxConfig(), client: client, now: function () { return NOW; } }), /401/);
  const dry = await engine.processEvent(fixture('chili-piper-gclid-only'), { config: config.loadConfig({ HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN: 'test-token' }), client: client, now: function () { return NOW; } });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.lookup, 'unavailable');
});

test('engine: retries 429 responses honoring Retry-After', async function () {
  const fake = createFakeHubSpot({ rateLimitFirst: 2 });
  const delays = [];
  const client = new engine.HubSpotClient({ token: 'test-token', fetchImpl: fake.fetchImpl, sleep: async function (ms) { delays.push(ms); } });
  const result = await engine.processEvent(fixture('chili-piper-gclid-only'), { config: sandboxConfig(), client: client, now: function () { return NOW; } });
  assert.equal(result.status, 'created');
  assert.deepEqual(delays, [1000, 1000]);
});

test('engine: webhook HMAC signatures are verified in constant time', function () {
  const body = Buffer.from('{"email":"pat.doe@example.com"}');
  const secret = 'test-secret';
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(engine.verifyWebhookSignature(body, signature, secret), true);
  assert.equal(engine.verifyWebhookSignature(body, 'sha256=' + signature, secret), true);
  assert.equal(engine.verifyWebhookSignature(body, signature.replace(/.$/, signature.endsWith('0') ? '1' : '0'), secret), false);
  assert.equal(engine.verifyWebhookSignature(body, 'short', secret), false);
  assert.equal(engine.verifyWebhookSignature(body, signature, null), false);
});

test('engine: webhook server refuses to start without a secret when signatures are required', function () {
  assert.throws(function () { engine.createWebhookServer({ config: config.loadConfig({}) }); }, /WEBHOOK_SECRET/);
});

test('engine: logs mask email addresses', function () {
  assert.equal(engine.maskEmail('alex.rivera@example.com'), 'a***@example.com');
});

// ---------------------------------------------------------------------------
// 7. workflow.json
// ---------------------------------------------------------------------------

const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));

function nodeByName(name) {
  const node = WORKFLOW.nodes.find(function (n) { return n.name === name; });
  assert.ok(node, 'missing node ' + name);
  return node;
}

function runCodeNode(name, context, withoutUrl) {
  const sandbox = Object.assign({ console: console }, withoutUrl ? {} : { URL: URL }, context);
  vm.createContext(sandbox);
  return plain(vm.runInContext('(function () {\n' + nodeByName(name).parameters.jsCode + '\n})()', sandbox));
}

function nodeRef(outputs) {
  return function (name) {
    if (!(name in outputs)) throw new Error('Unexpected node reference ' + name);
    return { first: function () { return { json: outputs[name] }; }, all: function () { return [{ json: outputs[name] }]; } };
  };
}

function inputOf(json) {
  return { first: function () { return { json: json }; }, all: function () { return [{ json: json }]; } };
}

test('workflow: is valid, inactive, and in sync with src/', function () {
  assert.equal(WORKFLOW.active, false);
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), builder.render(), 'run npm run build:workflow');
  const names = WORKFLOW.nodes.map(function (n) { return n.name; });
  assert.equal(new Set(names).size, names.length, 'node names are unique');
  Object.keys(WORKFLOW.connections).forEach(function (source) {
    assert.ok(names.includes(source), 'connection source ' + source);
    WORKFLOW.connections[source].main.forEach(function (branch) {
      branch.forEach(function (edge) { assert.ok(names.includes(edge.node), 'connection target ' + edge.node); });
    });
  });
});

test('workflow: config node defaults to DRY_RUN=true and SANDBOX_MODE=true, even with env access blocked', function () {
  const body = { email: 'pat.doe@example.com' };
  const open = runCodeNode(builder.CONFIG_NODE, { $env: {}, $input: inputOf({ body: body }) });
  assert.equal(open[0].json.config.dryRun, true);
  assert.equal(open[0].json.config.sandboxMode, true);
  assert.equal(open[0].json.config.writeMode, 'dry_run');
  const blocked = new Proxy({}, { get: function () { throw new Error('access to env vars denied'); } });
  const locked = runCodeNode(builder.CONFIG_NODE, { $env: blocked, $input: inputOf({ body: body }) });
  assert.equal(locked[0].json.config.writeMode, 'dry_run');
  assert.throws(function () {
    runCodeNode(builder.CONFIG_NODE, { $env: { DRY_RUN: 'false', SANDBOX_MODE: 'false' }, $input: inputOf({ body: body }) });
  }, /ALLOW_PRODUCTION_WRITES/);
});

test('workflow: every CRM write node is reachable only through the write gate and sandbox check', function () {
  const edges = [];
  Object.keys(WORKFLOW.connections).forEach(function (source) {
    WORKFLOW.connections[source].main.forEach(function (branch, outputIndex) {
      branch.forEach(function (edge) { edges.push({ from: source, out: outputIndex, to: edge.node }); });
    });
  });
  const writeNodes = WORKFLOW.nodes.filter(function (n) {
    return n.type === 'n8n-nodes-base.httpRequest' && ['PATCH', 'PUT', 'DELETE'].includes(n.parameters.method) ||
      (n.type === 'n8n-nodes-base.httpRequest' && n.parameters.method === 'POST' && !/\/search$/.test(n.parameters.url));
  }).map(function (n) { return n.name; });
  assert.deepEqual(writeNodes.sort(), ['HubSpot: Create Contact', 'HubSpot: Update Contact']);

  function reachable(skip) {
    const seen = new Set(['Conversion Webhook']);
    const queue = ['Conversion Webhook'];
    while (queue.length) {
      const current = queue.shift();
      edges.filter(function (e) { return e.from === current && !skip(e); }).forEach(function (e) {
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      });
    }
    return seen;
  }
  const all = reachable(function () { return false; });
  writeNodes.forEach(function (n) { assert.ok(all.has(n), n + ' is wired'); });
  const withoutWriteGate = reachable(function (e) { return e.from === 'Writes Enabled?' && e.out === 0; });
  const withoutSandboxGate = reachable(function (e) { return e.from === 'Enforce Sandbox Gate'; });
  writeNodes.forEach(function (n) {
    assert.equal(withoutWriteGate.has(n), false, n + ' bypasses Writes Enabled?');
    assert.equal(withoutSandboxGate.has(n), false, n + ' bypasses Enforce Sandbox Gate');
  });
});

test('workflow: credentials and secrets are placeholders only', function () {
  WORKFLOW.nodes.forEach(function (node) {
    Object.values(node.credentials || {}).forEach(function (cred) {
      assert.match(cred.id, /^REPLACE_WITH_/);
    });
  });
  assert.equal(nodeByName('Conversion Webhook').parameters.authentication, 'headerAuth');
});

test('workflow: Normalize & Validate node matches src/normalizer.js on every fixture (with and without URL)', function () {
  const cfg = config.parseConfig({});
  FIXTURES.events.forEach(function (entry) {
    const outputs = { 'Load Config (Fail-Safe Defaults)': { config: cfg } };
    [false, true].forEach(function (withoutUrl) {
      const result = runCodeNode('Normalize & Validate', { $: nodeRef(outputs), $input: inputOf({ body: entry.payload }) }, withoutUrl)[0].json;
      const expected = normalizer.normalizeEvent(entry.payload, { now: new Date(), internalHosts: cfg.internalHosts });
      assert.equal(result.valid, expected.valid, entry.fixture_id);
      if (expected.valid) {
        assert.deepEqual(result.event, plain(expected.event), entry.fixture_id + (withoutUrl ? ' (fallback parser)' : ''));
        assert.deepEqual(result.touchpoint, plain(normalizer.buildTouchpoint(expected.event)), entry.fixture_id);
      } else {
        assert.deepEqual(result.errors, expected.errors, entry.fixture_id);
      }
    });
  });
});

test('workflow: merge nodes match src/hubspot-mapper.js and refuse to write after a failed lookup', function () {
  const dryCfg = config.parseConfig({});
  const event = normalized('calendly-booking-linkedin-alias');
  const touchpoint = normalizer.buildTouchpoint(event);
  const existingProps = { email: event.email, ft_utm_source: 'facebook', ft_timestamp: '2026-10-01T09:15:00.000Z', lt_utm_source: 'facebook', lt_timestamp: '2026-10-01T09:15:00.000Z' };
  const outputs = {
    'Load Config (Fail-Safe Defaults)': { config: dryCfg },
    'Normalize & Validate': { valid: true, event: plain(event), touchpoint: plain(touchpoint), warnings: [] }
  };
  const searchResponse = { statusCode: 200, body: { results: [{ id: '5001', properties: existingProps }] } };
  const pass1 = runCodeNode('Build Merge Payload (Pass 1)', { $: nodeRef(outputs), $input: inputOf(searchResponse) })[0].json;
  const expected = mapper.buildContactWrite({ existing: { id: '5001', properties: existingProps }, event: event, touchpoint: touchpoint, options: mapper.mapperOptionsFromConfig(dryCfg) });
  assert.deepEqual(pass1.properties, plain(expected.properties));
  assert.equal(pass1.action, 'update');
  assert.equal(pass1.writesEnabled, false, 'dry run never enables writes');

  const pass2 = runCodeNode('Rebuild Merge Payload (Pass 2)', { $: nodeRef(outputs), $input: inputOf({ id: '5001', properties: existingProps }) })[0].json;
  assert.deepEqual(pass2.properties, plain(expected.properties));

  const failedLookup = { error: { message: 'Credentials not found' } };
  const dryFailed = runCodeNode('Build Merge Payload (Pass 1)', { $: nodeRef(outputs), $input: inputOf(failedLookup) })[0].json;
  assert.equal(dryFailed.action, 'create');
  assert.ok(dryFailed.warnings.includes('lookup_unavailable_in_dry_run_assumed_new_contact'));

  const sbxOutputs = Object.assign({}, outputs, { 'Load Config (Fail-Safe Defaults)': { config: config.parseConfig({ DRY_RUN: 'false' }) } });
  assert.throws(function () {
    runCodeNode('Build Merge Payload (Pass 1)', { $: nodeRef(sbxOutputs), $input: inputOf(failedLookup) });
  }, /Refusing to write/);
});

test('workflow: sandbox gate node blocks production portals and conflict node parses 409s', function () {
  const outputs = {
    'Load Config (Fail-Safe Defaults)': { config: config.parseConfig({ DRY_RUN: 'false' }) },
    'Build Merge Payload (Pass 1)': { action: 'create', properties: {}, eventId: 'abc' },
    'Enforce Sandbox Gate': { eventId: 'abc' }
  };
  assert.throws(function () {
    runCodeNode('Enforce Sandbox Gate', { $: nodeRef(outputs), $input: inputOf({ portalId: 1001, accountType: 'STANDARD' }) });
  }, /Write blocked by gate/);
  const ok = runCodeNode('Enforce Sandbox Gate', { $: nodeRef(outputs), $input: inputOf({ portalId: 1001, accountType: 'DEVELOPER_TEST' }) })[0].json;
  assert.equal(ok.writeTarget, 'sandbox_account_verified');

  const conflict = runCodeNode('Check Create Result', { $: nodeRef(outputs), $input: inputOf({ statusCode: 409, body: { message: 'Contact already exists. Existing ID: 5001' } }) })[0].json;
  assert.deepEqual([conflict.conflict, conflict.contactId], [true, '5001']);
  const created = runCodeNode('Check Create Result', { $: nodeRef(outputs), $input: inputOf({ statusCode: 201, body: { id: '5002' } }) })[0].json;
  assert.deepEqual([created.conflict, created.contactId], [false, '5002']);
  assert.throws(function () {
    runCodeNode('Check Create Result', { $: nodeRef(outputs), $input: inputOf({ statusCode: 400, body: {} }) });
  }, /status 400/);
});

// ---------------------------------------------------------------------------
// 8. Security scan
// ---------------------------------------------------------------------------

// Every non-RFC-2606 domain allowed in this repository, and why. Adding a
// domain here is a deliberate, reviewable act.
const DOMAIN_ALLOWLIST = {
  'dhrobinsystems.com': 'author website and contact (README author block)',
  'behance.net': 'author portfolio (README author block)',
  'linkedin.com': 'author profile, plus referrer/source classification key',
  'github.com': 'repository links in README and package.json',
  'hubapi.com': 'HubSpot API base URL',
  'facebook.com': 'referrer/source classification key',
  'instagram.com': 'referrer/source classification key',
  'google.com': 'referrer/source classification key',
  'bing.com': 'referrer/source classification key',
  'duckduckgo.com': 'referrer classification key',
  'yahoo.com': 'referrer classification key',
  'twitter.com': 'referrer/source classification key',
  'x.com': 'referrer/source classification key',
  't.co': 'referrer/source classification key',
  'youtube.com': 'referrer/source classification key',
  'reddit.com': 'referrer/source classification key',
  'google.co': 'regex-free mention of Google country domains in docs and tests'
};
const ALLOWED_EMAIL_DOMAINS = ['dhrobinsystems.com'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage']);

function listRepoFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (entry) {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listRepoFiles(full) : [full];
  });
}

function isRfc2606(host) {
  return /(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)(test|example|invalid|localhost)$/.test(host);
}

function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (isRfc2606(h)) return true;
  return Object.keys(DOMAIN_ALLOWLIST).some(function (d) { return h === d || h.endsWith('.' + d); });
}

const SECRET_PATTERNS = [
  { name: 'private key block', re: new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' ')) },
  { name: 'HubSpot private app token', re: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'HubSpot legacy API key', re: /hapikey=[0-9a-f]{8}-[0-9a-f]{4}-/i },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'hard-coded secret assignment', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\s*[=:]\s*["']?(?!REPLACE_WITH_)[A-Za-z0-9\-_./+]{16,}/ }
];

test('security: no real secrets, private keys, or tokens in any repository file', function () {
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    SECRET_PATTERNS.forEach(function (pattern) {
      if (pattern.re.test(text)) findings.push(path.relative(ROOT, file) + ': ' + pattern.name);
    });
  });
  assert.deepEqual(findings, []);
});

test('security: no committed .env file and .env.example holds placeholders or safe defaults only', function () {
  assert.equal(fs.existsSync(path.join(ROOT, '.env')), false);
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
  const safe = /^(REPLACE_WITH_[A-Z0-9_]+|true|false|\d+|preserve|https:\/\/api\.hubapi\.com|127\.0\.0\.1|)$/;
  lines.forEach(function (line) {
    const value = line.slice(line.indexOf('=') + 1).trim();
    assert.match(value, safe, line);
  });
  assert.ok(lines.includes('DRY_RUN=true'));
  assert.ok(lines.includes('SANDBOX_MODE=true'));
});

test('security: only RFC 2606 domains (plus the documented allowlist) appear in any file', function () {
  const domainRe = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev|in))\b/gi;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = domainRe.exec(text)) !== null) {
      const host = match[1];
      if (/^[a-z0-9-]+\.(js|json)$/i.test(host)) continue;
      if (host.toLowerCase() === 'lnkd.in') continue; // LinkedIn short-link referrer key
      if (!isAllowedHost(host)) findings.push(path.relative(ROOT, file) + ': ' + host);
    }
  });
  assert.deepEqual(Array.from(new Set(findings)), []);
});

test('security: every email address uses an RFC 2606 domain or the documented author contact', function () {
  const emailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = emailRe.exec(text)) !== null) {
      const domain = match[1].toLowerCase();
      if (!isRfc2606(domain) && !ALLOWED_EMAIL_DOMAINS.includes(domain)) findings.push(path.relative(ROOT, file) + ': ' + match[0]);
    }
  });
  assert.deepEqual(findings, []);
});

test('security: the scanner itself catches a planted secret and a foreign domain', function () {
  const plantedToken = ['pat', 'na1', '12345678-1234-1234-1234-123456789abc'].join('-');
  assert.ok(SECRET_PATTERNS.some(function (p) { return p.re.test('token=' + plantedToken); }));
  assert.equal(isAllowedHost(['acme-corp', 'com'].join('.')), false);
  assert.equal(isAllowedHost('app.example.com'), true);
});
