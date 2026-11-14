#!/usr/bin/env node
'use strict';

/**
 * build-workflow.js
 *
 * Generates workflow.json from the src/ modules so the n8n Code nodes and the
 * standalone engine run the exact same normalization, mapping, and gate code.
 *
 *   node scripts/build-workflow.js          regenerate workflow.json
 *   node scripts/build-workflow.js --check  exit 1 if workflow.json is stale
 *
 * I edit logic in src/ only, then rebuild. Hand-editing Code nodes in
 * workflow.json breaks the parity tests on purpose.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CONTACT_READ_PROPERTIES } = require('../src/hubspot-mapper');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'workflow.json');
const CONFIG_NODE = 'Load Config (Fail-Safe Defaults)';
const CFG = "$('" + CONFIG_NODE + "').first().json.config";

function extractCore(relativeFile, name) {
  const source = fs.readFileSync(path.join(ROOT, relativeFile), 'utf8');
  const start = '// <n8n-core:' + name + '>';
  const end = '// </n8n-core:' + name + '>';
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  if (i === -1 || j === -1 || j < i) throw new Error('Missing n8n-core:' + name + ' markers in ' + relativeFile);
  return source.slice(i, j + end.length);
}

function bodyOf(fn) {
  const text = fn.toString();
  const lines = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min.apply(null, lines.filter(function (l) { return l.trim(); }).map(function (l) { return l.match(/^ */)[0].length; }));
  return lines.map(function (l) { return l.slice(indent); }).join('\n');
}

/* eslint-disable no-undef */
// The functions below are never executed in Node; their bodies become Code-node source.

function configGlue() {
  const readEnv = (key) => {
    try {
      const value = $env[key];
      return value === undefined || value === null ? undefined : String(value);
    } catch (error) {
      // N8N_BLOCK_ENV_ACCESS_IN_NODE=true: fall back to the fail-safe defaults.
      return undefined;
    }
  };
  const env = {};
  for (const key of CONFIG_KEYS) env[key] = readEnv(key);
  const config = parseConfig(env);
  return $input.all().map((item) => ({
    json: { config, body: item.json.body, receivedAt: new Date().toISOString() }
  }));
}

function normalizeGlue() {
  const config = $('Load Config (Fail-Safe Defaults)').first().json.config;
  const body = $input.first().json.body;
  if (Array.isArray(body)) {
    return [{ json: { valid: false, errors: ['batch_payloads_not_supported_send_one_event_per_request'], warnings: [] } }];
  }
  const result = normalizeEvent(body, { now: new Date(), internalHosts: config.internalHosts });
  if (!result.valid) return [{ json: { valid: false, errors: result.errors, warnings: result.warnings } }];
  return [{ json: { valid: true, event: result.event, touchpoint: buildTouchpoint(result.event), warnings: result.warnings } }];
}

function pass1Glue() {
  const config = $('Load Config (Fail-Safe Defaults)').first().json.config;
  const normalized = $('Normalize & Validate').first().json;
  const lookup = $input.first().json;
  const warnings = normalized.warnings.slice();
  const lookupOk = !lookup.error && Number(lookup.statusCode) === 200;
  let existing = null;
  if (!lookupOk) {
    if (config.writeMode !== 'dry_run') {
      throw new Error('HubSpot contact lookup failed (status ' + (lookup.statusCode || 'n/a') + '). Refusing to write without a confirmed lookup.');
    }
    warnings.push('lookup_unavailable_in_dry_run_assumed_new_contact');
  } else {
    const results = lookup.body && Array.isArray(lookup.body.results) ? lookup.body.results : [];
    if (results.length > 0) existing = { id: String(results[0].id), properties: results[0].properties || {} };
  }
  const plan = buildContactWrite({
    existing,
    event: normalized.event,
    touchpoint: normalized.touchpoint,
    options: mapperOptionsFromConfig(config)
  });
  return [{
    json: Object.assign({}, plan, {
      pass: 1,
      eventId: normalized.event.event_id,
      writeMode: config.writeMode,
      lookup: !lookupOk ? 'unavailable' : (existing ? 'found' : 'not_found'),
      writesEnabled: config.writeMode !== 'dry_run' && plan.action !== 'skip',
      warnings: warnings.concat(plan.warnings)
    })
  }];
}

function sandboxGateGlue() {
  const config = $('Load Config (Fail-Safe Defaults)').first().json.config;
  const plan = $('Build Merge Payload (Pass 1)').first().json;
  const account = $input.first().json;
  const verdict = evaluateWriteTarget(config, account);
  if (!verdict.allowed) throw new Error('Write blocked by gate: ' + verdict.reason);
  return [{ json: Object.assign({}, plan, { writeTarget: verdict.reason, portalId: account.portalId }) }];
}

function checkCreateGlue() {
  const plan = $('Enforce Sandbox Gate').first().json;
  const response = $input.first().json;
  const status = Number(response.statusCode);
  if (status === 200 || status === 201) {
    return [{ json: { conflict: false, status: 'created', contactId: String(response.body && response.body.id), eventId: plan.eventId } }];
  }
  if (status === 409) {
    const contactId = parseExistingIdFromConflict(response.body);
    if (!contactId) throw new Error('Create returned 409 but no existing contact ID was found in the response.');
    return [{ json: { conflict: true, status: 'conflict', contactId, eventId: plan.eventId } }];
  }
  throw new Error('HubSpot create failed with status ' + (response.statusCode || 'n/a') + '.');
}

function pass2Glue() {
  const config = $('Load Config (Fail-Safe Defaults)').first().json.config;
  const normalized = $('Normalize & Validate').first().json;
  const contact = $input.first().json;
  const existing = { id: String(contact.id), properties: contact.properties || {} };
  const plan = buildContactWrite({
    existing,
    event: normalized.event,
    touchpoint: normalized.touchpoint,
    options: mapperOptionsFromConfig(config)
  });
  return [{
    json: Object.assign({}, plan, {
      pass: 2,
      eventId: normalized.event.event_id,
      writeMode: config.writeMode,
      hasChanges: plan.action !== 'skip',
      warnings: normalized.warnings.concat(plan.warnings)
    })
  }];
}
/* eslint-enable no-undef */

function codeNode(name, id, position, cores, glue) {
  const header = '// GENERATED by scripts/build-workflow.js from src/. Edit src/, then rebuild.\n';
  return {
    parameters: { jsCode: header + cores.concat([bodyOf(glue)]).join('\n\n') + '\n' },
    id: id,
    name: name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: position
  };
}

function ifNode(name, id, position, condition) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [Object.assign({ id: id + '-condition' }, condition)],
        combinator: 'and'
      },
      options: {}
    },
    id: id,
    name: name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: position
  };
}

function booleanTrue(expression) {
  return { leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } };
}

const HUBSPOT_CREDENTIAL = {
  hubspotAppToken: {
    id: 'REPLACE_WITH_N8N_HUBSPOT_CREDENTIAL_ID',
    name: 'HubSpot Sandbox Private App (REPLACE_WITH_YOUR_CREDENTIAL)'
  }
};

function httpNode(name, id, position, params, extra) {
  return Object.assign({
    parameters: Object.assign({
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'hubspotAppToken'
    }, params),
    id: id,
    name: name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: position,
    credentials: HUBSPOT_CREDENTIAL
  }, extra || {});
}

function respondNode(name, id, position, code, body) {
  return {
    parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } },
    id: id,
    name: name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: position
  };
}

const FULL_RESPONSE = { response: { response: { fullResponse: true, neverError: true } } };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const READ_PROPS = CONTACT_READ_PROPERTIES.join(',');

function buildWorkflow() {
  const configCore = extractCore('src/config.js', 'config');
  const normalizerCore = extractCore('src/normalizer.js', 'normalizer');
  const mapperCore = extractCore('src/hubspot-mapper.js', 'mapper');
  const id = function (n) { return '1001a000-0000-4000-8000-' + String(n).padStart(12, '0'); };

  const nodes = [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'utm-session-stitcher',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {}
      },
      id: id(1),
      name: 'Conversion Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 300],
      webhookId: '2002b000-0000-4000-8000-000000000001',
      credentials: {
        httpHeaderAuth: {
          id: 'REPLACE_WITH_N8N_HEADER_AUTH_CREDENTIAL_ID',
          name: 'Conversion Webhook Header Auth (REPLACE_WITH_YOUR_CREDENTIAL)'
        }
      }
    },
    codeNode(CONFIG_NODE, id(2), [220, 300], [configCore], configGlue),
    codeNode('Normalize & Validate', id(3), [440, 300], [normalizerCore], normalizeGlue),
    ifNode('Payload Valid?', id(4), [660, 300], booleanTrue('={{ $json.valid }}')),
    respondNode('Respond 422 (Rejected)', id(5), [880, 500], 422,
      "={{ JSON.stringify({ status: 'rejected', errors: $json.errors, warnings: $json.warnings }) }}"),
    httpNode('HubSpot: Search Contact by Email', id(6), [880, 200], {
      method: 'POST',
      url: '={{ ' + CFG + '.hubspotBaseUrl }}/crm/v3/objects/contacts/search',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: $json.event.email }] }], properties: '" + READ_PROPS + "'.split(','), limit: 1 }) }}",
      options: FULL_RESPONSE
    }, { onError: 'continueRegularOutput', alwaysOutputData: true }),
    codeNode('Build Merge Payload (Pass 1)', id(7), [1100, 200], [normalizerCore, mapperCore], pass1Glue),
    ifNode('Writes Enabled?', id(8), [1320, 200], booleanTrue('={{ $json.writesEnabled }}')),
    respondNode('Respond 200 (Dry Run / Skipped)', id(9), [1540, 420], 200,
      "={{ JSON.stringify({ status: $json.action === 'skip' ? 'skipped' : 'dry_run', writeMode: $json.writeMode, eventId: $json.eventId, lookup: $json.lookup, action: $json.action, reason: $json.reason, decisions: $json.decisions, properties: $json.properties, warnings: $json.warnings }) }}"),
    httpNode('HubSpot: Verify Portal Type', id(10), [1540, 100], {
      method: 'GET',
      url: '={{ ' + CFG + '.hubspotBaseUrl }}/account-info/v3/details',
      options: {}
    }, RETRY),
    codeNode('Enforce Sandbox Gate', id(11), [1760, 100], [configCore], sandboxGateGlue),
    ifNode('Create or Update?', id(12), [1980, 100], {
      leftValue: '={{ $json.action }}',
      rightValue: 'create',
      operator: { type: 'string', operation: 'equals' }
    }),
    httpNode('HubSpot: Create Contact', id(13), [2200, 0], {
      method: 'POST',
      url: '={{ ' + CFG + '.hubspotBaseUrl }}/crm/v3/objects/contacts',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ properties: $json.properties }) }}',
      options: FULL_RESPONSE
    }),
    codeNode('Check Create Result', id(14), [2420, 0], [normalizerCore, mapperCore], checkCreateGlue),
    ifNode('Create Conflict (409)?', id(15), [2640, 0], booleanTrue('={{ $json.conflict }}')),
    httpNode('HubSpot: Re-Fetch Contact (Pass 2)', id(16), [2860, -120], {
      method: 'GET',
      url: '={{ ' + CFG + '.hubspotBaseUrl }}/crm/v3/objects/contacts/{{ $json.contactId }}',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'properties', value: READ_PROPS }] },
      options: {}
    }, RETRY),
    codeNode('Rebuild Merge Payload (Pass 2)', id(17), [3080, -120], [normalizerCore, mapperCore], pass2Glue),
    ifNode('Pass 2 Has Changes?', id(18), [3300, -120], booleanTrue('={{ $json.hasChanges }}')),
    respondNode('Respond 200 (No Changes)', id(19), [3520, 40], 200,
      "={{ JSON.stringify({ status: 'skipped', pass: 2, eventId: $json.eventId, reason: $json.reason }) }}"),
    httpNode('HubSpot: Update Contact', id(20), [3520, 200], {
      method: 'PATCH',
      url: '={{ ' + CFG + '.hubspotBaseUrl }}/crm/v3/objects/contacts/{{ $json.contactId }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ properties: $json.properties }) }}',
      options: {}
    }, RETRY),
    respondNode('Respond 200 (Written)', id(21), [3740, 100], 200,
      "={{ JSON.stringify({ status: 'written', eventId: $('Normalize & Validate').first().json.event.event_id, writeMode: " + CFG + '.writeMode }) }}')
  ];

  const link = function (target) { return { node: target, type: 'main', index: 0 }; };
  const connections = {
    'Conversion Webhook': { main: [[link(CONFIG_NODE)]] },
    [CONFIG_NODE]: { main: [[link('Normalize & Validate')]] },
    'Normalize & Validate': { main: [[link('Payload Valid?')]] },
    'Payload Valid?': { main: [[link('HubSpot: Search Contact by Email')], [link('Respond 422 (Rejected)')]] },
    'HubSpot: Search Contact by Email': { main: [[link('Build Merge Payload (Pass 1)')]] },
    'Build Merge Payload (Pass 1)': { main: [[link('Writes Enabled?')]] },
    'Writes Enabled?': { main: [[link('HubSpot: Verify Portal Type')], [link('Respond 200 (Dry Run / Skipped)')]] },
    'HubSpot: Verify Portal Type': { main: [[link('Enforce Sandbox Gate')]] },
    'Enforce Sandbox Gate': { main: [[link('Create or Update?')]] },
    'Create or Update?': { main: [[link('HubSpot: Create Contact')], [link('HubSpot: Update Contact')]] },
    'HubSpot: Create Contact': { main: [[link('Check Create Result')]] },
    'Check Create Result': { main: [[link('Create Conflict (409)?')]] },
    'Create Conflict (409)?': { main: [[link('HubSpot: Re-Fetch Contact (Pass 2)')], [link('Respond 200 (Written)')]] },
    'HubSpot: Re-Fetch Contact (Pass 2)': { main: [[link('Rebuild Merge Payload (Pass 2)')]] },
    'Rebuild Merge Payload (Pass 2)': { main: [[link('Pass 2 Has Changes?')]] },
    'Pass 2 Has Changes?': { main: [[link('HubSpot: Update Contact')], [link('Respond 200 (No Changes)')]] },
    'HubSpot: Update Contact': { main: [[link('Respond 200 (Written)')]] }
  };

  return {
    name: 'HubSpot Multi-Touch UTM Session Stitcher (DRY RUN + SANDBOX by default)',
    nodes: nodes,
    connections: connections,
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: []
  };
}

function render() {
  return JSON.stringify(buildWorkflow(), null, 2) + '\n';
}

if (require.main === module) {
  const output = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== output) {
      process.stderr.write('workflow.json is out of date. Run: npm run build:workflow\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('workflow.json is in sync with src/.\n');
    }
  } else {
    fs.writeFileSync(OUTPUT, output);
    process.stdout.write('Wrote ' + path.relative(process.cwd(), OUTPUT) + '\n');
  }
}

module.exports = { buildWorkflow, render, extractCore, bodyOf, CONFIG_NODE };
