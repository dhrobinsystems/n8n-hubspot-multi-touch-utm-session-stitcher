#!/usr/bin/env node
'use strict';

/**
 * index.js
 *
 * Standalone Node.js attribution engine. It mirrors workflow.json node for node:
 *
 *   webhook -> config gates -> normalize/validate -> contact lookup (pass 1)
 *     -> merge plan -> [dry run: return preview]
 *     -> write-target gate (sandbox account check) -> create or update
 *     -> on 409 conflict: re-fetch by ID (pass 2) -> rebuild plan -> update
 *
 * Usage:
 *   node src/index.js --file test/fixtures/conversion-events-batch.json
 *   node src/index.js --serve            (local webhook on 127.0.0.1:8787)
 *   node --env-file=.env src/index.js --serve
 *
 * Zero runtime dependencies: global fetch (Node 18+), node:http, node:crypto.
 */

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const { loadConfig, evaluateWriteTarget, describeConfig } = require('./config');
const { normalizeEvent, buildTouchpoint } = require('./normalizer');
const {
  CONTACT_READ_PROPERTIES,
  buildContactWrite,
  mapperOptionsFromConfig,
  parseExistingIdFromConflict
} = require('./hubspot-mapper');

const WEBHOOK_PATH = '/webhook/utm-session-stitcher';
const MAX_BODY_BYTES = 256 * 1024;

class HubSpotApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status;
    this.body = body;
  }
}

class WriteGateError extends Error {
  constructor(reason) {
    super('Write blocked by gate: ' + reason);
    this.name = 'WriteGateError';
    this.reason = reason;
  }
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || email.indexOf('@') === -1) return email;
  const [local, domain] = email.split('@');
  return (local.slice(0, 1) || '*') + '***@' + domain;
}

function createLogger(options) {
  const opts = options || {};
  const write = function (level, message, fields) {
    if (opts.silent) return;
    const line = Object.assign({ level: level, time: new Date().toISOString(), message: message }, fields || {});
    if (line.email) line.email = maskEmail(line.email);
    process.stderr.write(JSON.stringify(line) + '\n');
  };
  return {
    info: function (message, fields) { write('info', message, fields); },
    warn: function (message, fields) { write('warn', message, fields); },
    error: function (message, fields) { write('error', message, fields); }
  };
}

class HubSpotClient {
  constructor(options) {
    if (!options || !options.token) throw new Error('HubSpotClient requires a token.');
    this.token = options.token;
    this.baseUrl = String(options.baseUrl || 'https://api.hubapi.com').replace(/\/+$/, '');
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    this.baseDelayMs = options.baseDelayMs === undefined ? 500 : options.baseDelayMs;
    this.sleep = options.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    if (typeof this.fetch !== 'function') throw new Error('No fetch implementation available (Node 18+ required).');
  }

  async request(method, apiPath, body) {
    const url = this.baseUrl + apiPath;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(url, {
        method: method,
        headers: {
          Authorization: 'Bearer ' + this.token,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch (error) { parsed = { raw: text }; }
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.baseDelayMs * Math.pow(2, attempt);
        await this.sleep(delay);
        continue;
      }
      return { status: response.status, body: parsed };
    }
  }

  static expectOk(result, context) {
    if (result.status >= 200 && result.status < 300) return result.body;
    const detail = result.body && result.body.message ? ': ' + result.body.message : '';
    throw new HubSpotApiError(context + ' failed with status ' + result.status + detail, result.status, result.body);
  }

  async getAccountDetails() {
    return HubSpotClient.expectOk(await this.request('GET', '/account-info/v3/details'), 'Account details lookup');
  }

  async searchContactByEmail(email, properties) {
    const body = HubSpotClient.expectOk(await this.request('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: properties || CONTACT_READ_PROPERTIES.slice(),
      limit: 1
    }), 'Contact search');
    const results = body && Array.isArray(body.results) ? body.results : [];
    return results.length > 0 ? { id: String(results[0].id), properties: results[0].properties || {} } : null;
  }

  async getContact(id, properties) {
    const query = '?properties=' + encodeURIComponent((properties || CONTACT_READ_PROPERTIES).join(','));
    const body = HubSpotClient.expectOk(
      await this.request('GET', '/crm/v3/objects/contacts/' + encodeURIComponent(id) + query),
      'Contact fetch'
    );
    return { id: String(body.id), properties: body.properties || {} };
  }

  async createContact(properties) {
    // Returns the raw result so the caller can handle 409 conflicts.
    return this.request('POST', '/crm/v3/objects/contacts', { properties: properties });
  }

  async updateContact(id, properties) {
    return HubSpotClient.expectOk(
      await this.request('PATCH', '/crm/v3/objects/contacts/' + encodeURIComponent(id), { properties: properties }),
      'Contact update'
    );
  }
}

function createClientFromConfig(config, fetchImpl) {
  if (!config.hubspotToken) return null;
  if (config.writeMode === 'dry_run' && !config.lookupInDryRun) return null;
  return new HubSpotClient({ token: config.hubspotToken, baseUrl: config.hubspotBaseUrl, fetchImpl: fetchImpl });
}

async function assertWriteTarget(client, config, state) {
  const cache = state || {};
  if (!cache.verdict) {
    const account = config.writeMode === 'sandbox' ? await client.getAccountDetails() : null;
    cache.verdict = evaluateWriteTarget(config, account);
  }
  if (!cache.verdict.allowed) throw new WriteGateError(cache.verdict.reason);
  return cache.verdict;
}

async function processEvent(raw, deps) {
  const config = deps.config;
  const client = deps.client || null;
  const logger = deps.logger || createLogger({ silent: true });
  const now = deps.now ? deps.now() : new Date();
  const writesEnabled = config.writeMode !== 'dry_run';

  const normalized = normalizeEvent(raw, { now: now, internalHosts: config.internalHosts });
  if (!normalized.valid) {
    logger.warn('event_rejected', { errors: normalized.errors });
    return { status: 'rejected', errors: normalized.errors, warnings: normalized.warnings };
  }

  const event = normalized.event;
  const touchpoint = buildTouchpoint(event);
  const options = mapperOptionsFromConfig(config);
  const warnings = normalized.warnings.slice();

  if (writesEnabled && !client) {
    throw new Error('Writes are enabled but no HubSpot client is configured.');
  }

  // Pass 1: look the contact up by email.
  let existing = null;
  let lookup = 'skipped_no_client';
  if (client) {
    try {
      existing = await client.searchContactByEmail(event.email);
      lookup = existing ? 'found' : 'not_found';
    } catch (error) {
      if (writesEnabled) throw error; // Never write without a confirmed lookup.
      lookup = 'unavailable';
      warnings.push('lookup_unavailable_in_dry_run_assumed_new_contact');
    }
  } else {
    warnings.push('lookup_skipped_in_dry_run_assumed_new_contact');
  }

  const plan = buildContactWrite({ existing: existing, event: event, touchpoint: touchpoint, options: options });
  const base = {
    eventId: event.event_id,
    email: event.email,
    eventType: event.event_type,
    attribution: { source: event.utm_source, medium: event.utm_medium, campaign: event.utm_campaign, method: event.attribution_method },
    writeMode: config.writeMode,
    lookup: lookup,
    decisions: plan.decisions,
    warnings: warnings.concat(plan.warnings)
  };

  if (plan.action === 'skip') {
    logger.info('event_skipped', { eventId: event.event_id, reason: plan.reason, email: event.email });
    return Object.assign(base, { status: 'skipped', reason: plan.reason, contactId: plan.contactId });
  }

  if (!writesEnabled) {
    logger.info('dry_run_plan', { eventId: event.event_id, action: plan.action, email: event.email });
    return Object.assign(base, { status: 'dry_run', plan: { action: plan.action, contactId: plan.contactId, properties: plan.properties } });
  }

  await assertWriteTarget(client, config, deps.gateState);

  if (plan.action === 'update') {
    await client.updateContact(plan.contactId, plan.properties);
    logger.info('contact_updated', { eventId: event.event_id, contactId: plan.contactId });
    return Object.assign(base, { status: 'updated', pass: 1, contactId: plan.contactId, properties: plan.properties });
  }

  const created = await client.createContact(plan.properties);
  if (created.status === 200 || created.status === 201) {
    const contactId = created.body && created.body.id ? String(created.body.id) : null;
    logger.info('contact_created', { eventId: event.event_id, contactId: contactId });
    return Object.assign(base, { status: 'created', pass: 1, contactId: contactId, properties: plan.properties });
  }

  if (created.status === 409) {
    // Pass 2: the contact was created between my search and my create
    // (or the search index had not caught up). Re-read it and rebuild the plan
    // so First-Touch immutability still holds.
    let contactId = parseExistingIdFromConflict(created.body);
    if (!contactId) {
      const found = await client.searchContactByEmail(event.email);
      contactId = found ? found.id : null;
    }
    if (!contactId) {
      throw new HubSpotApiError('Create returned 409 but the existing contact ID could not be resolved.', 409, created.body);
    }
    const fresh = await client.getContact(contactId);
    const secondPlan = buildContactWrite({ existing: fresh, event: event, touchpoint: touchpoint, options: options });
    const secondBase = Object.assign(base, { lookup: 'conflict_refetched', decisions: secondPlan.decisions, warnings: warnings.concat(secondPlan.warnings) });
    if (secondPlan.action === 'skip') {
      return Object.assign(secondBase, { status: 'skipped', pass: 2, reason: secondPlan.reason, contactId: contactId });
    }
    await client.updateContact(contactId, secondPlan.properties);
    logger.info('contact_updated_after_conflict', { eventId: event.event_id, contactId: contactId });
    return Object.assign(secondBase, { status: 'updated', pass: 2, contactId: contactId, properties: secondPlan.properties });
  }

  throw new HubSpotApiError('Contact create failed with status ' + created.status, created.status, created.body);
}

async function processBatch(events, deps) {
  const results = [];
  const shared = Object.assign({ gateState: {} }, deps);
  // Sequential on purpose: same-contact events stay ordered and rate limits stay calm.
  for (let i = 0; i < events.length; i++) {
    try {
      results.push(await processEvent(events[i], shared));
    } catch (error) {
      results.push({ status: 'error', error: error.message, httpStatus: error.status || null });
    }
  }
  return results;
}

function summarize(results) {
  const counts = {};
  results.forEach(function (result) { counts[result.status] = (counts[result.status] || 0) + 1; });
  return counts;
}

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const provided = String(signatureHeader).replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

function createWebhookServer(deps) {
  const config = deps.config;
  if (config.requireWebhookSignature && !config.webhookSecret) {
    throw new Error('REQUIRE_WEBHOOK_SIGNATURE is on but WEBHOOK_SECRET is empty or a placeholder.');
  }
  const shared = Object.assign({ gateState: {} }, deps);
  const send = function (res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  return http.createServer(function (req, res) {
    if (req.method !== 'POST' || req.url.split('?')[0] !== WEBHOOK_PATH) return send(res, 404, { status: 'not_found' });
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        send(res, 413, { status: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async function () {
      if (aborted) return;
      const rawBody = Buffer.concat(chunks);
      if (config.requireWebhookSignature && !verifyWebhookSignature(rawBody, req.headers['x-signature'], config.webhookSecret)) {
        return send(res, 401, { status: 'invalid_signature' });
      }
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch (error) { return send(res, 400, { status: 'invalid_json' }); }
      if (Array.isArray(payload)) return send(res, 422, { status: 'rejected', errors: ['batch_payloads_not_supported_send_one_event_per_request'] });
      try {
        const result = await processEvent(payload, shared);
        return send(res, result.status === 'rejected' ? 422 : 200, result);
      } catch (error) {
        (shared.logger || createLogger()).error('event_failed', { error: error.message });
        return send(res, error instanceof WriteGateError ? 403 : 500, { status: 'error', error: error.message });
      }
    });
  });
}

function parseArgs(argv) {
  const args = { file: null, serve: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--serve') args.serve = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function loadEventsFromFile(filePath) {
  const data = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const list = Array.isArray(data) ? data : (Array.isArray(data.events) ? data.events : [data]);
  return list.map(function (entry) { return entry && entry.fixture_id && entry.payload ? entry.payload : entry; });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.file && !args.serve)) {
    process.stdout.write('Usage: node src/index.js --file <events.json> | --serve\n');
    return 0;
  }
  const config = loadConfig(process.env);
  const logger = createLogger();
  const client = createClientFromConfig(config);
  logger.info('config_loaded', { config: describeConfig(config) });

  if (args.file) {
    const results = await processBatch(loadEventsFromFile(args.file), { config: config, client: client, logger: logger });
    process.stdout.write(JSON.stringify({ writeMode: config.writeMode, summary: summarize(results), results: results }, null, 2) + '\n');
    return results.some(function (result) { return result.status === 'error'; }) ? 1 : 0;
  }

  const server = createWebhookServer({ config: config, client: client, logger: logger });
  await new Promise(function (resolve) { server.listen(config.port, config.host, resolve); });
  logger.info('webhook_listening', { url: 'http://' + config.host + ':' + config.port + WEBHOOK_PATH, writeMode: config.writeMode });
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    if (typeof code === 'number') process.exitCode = code;
  }).catch(function (error) {
    process.stderr.write(JSON.stringify({ level: 'error', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  WEBHOOK_PATH,
  HubSpotApiError,
  WriteGateError,
  HubSpotClient,
  maskEmail,
  createLogger,
  createClientFromConfig,
  assertWriteTarget,
  processEvent,
  processBatch,
  summarize,
  verifyWebhookSignature,
  createWebhookServer,
  loadEventsFromFile,
  main
};
