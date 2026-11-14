'use strict';

/**
 * config.js
 *
 * Environment loader for the attribution engine.
 *
 * Fail-safe rules I enforce here:
 *   - DRY_RUN and SANDBOX_MODE default to true. Only the literal string "false"
 *     (case-insensitive, trimmed) turns either one off. "0", "no", typos, and
 *     empty values all leave the safety flag ON.
 *   - Production writes (DRY_RUN=false AND SANDBOX_MODE=false) additionally
 *     require ALLOW_PRODUCTION_WRITES=true. Without it, loading fails loudly.
 *   - Any write mode refuses to start with an empty or REPLACE_WITH_* token.
 *   - In SANDBOX_MODE the engine only reads HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN,
 *     and the write gate verifies the portal's account type before any write.
 *
 * The region between the n8n-core:config markers is embedded verbatim into the
 * n8n workflow by scripts/build-workflow.js, so it must stay dependency-free.
 */

// <n8n-core:config>
const CONFIG_KEYS = [
  'DRY_RUN',
  'SANDBOX_MODE',
  'ALLOW_PRODUCTION_WRITES',
  'HUBSPOT_BASE_URL',
  'HUBSPOT_SANDBOX_PORTAL_ID',
  'MAX_TOUCHPOINTS',
  'MAX_HISTORY_CHARS',
  'ATTRIBUTION_WINDOW_DAYS',
  'PROTECT_LAST_TOUCH_FROM_DIRECT',
  'HISTORY_CORRUPT_STRATEGY',
  'INTERNAL_HOSTS',
  'LOOKUP_IN_DRY_RUN'
];

const SANDBOX_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];
const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const HISTORY_CORRUPT_STRATEGIES = ['preserve', 'reset'];

function safetyFlag(value) {
  // Defaults to true. Only the literal string "false" disables a safety flag.
  if (value === undefined || value === null) return true;
  return String(value).trim().toLowerCase() !== 'false';
}

function optInFlag(value) {
  // Defaults to false. Only the literal string "true" enables an opt-in flag.
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInt(value, fallback, min, max, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function csvList(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(',')
    .map(function (entry) { return entry.trim().toLowerCase(); })
    .filter(function (entry) { return entry.length > 0; });
}

function parseConfig(env) {
  const e = env || {};
  const dryRun = safetyFlag(e.DRY_RUN);
  const sandboxMode = safetyFlag(e.SANDBOX_MODE);
  const allowProductionWrites = optInFlag(e.ALLOW_PRODUCTION_WRITES);
  const writeMode = dryRun ? 'dry_run' : (sandboxMode ? 'sandbox' : 'production');

  if (writeMode === 'production' && !allowProductionWrites) {
    throw new Error(
      'Refusing to start: DRY_RUN=false and SANDBOX_MODE=false would write to a production portal. ' +
      'Set ALLOW_PRODUCTION_WRITES=true only after testing in a HubSpot sandbox.'
    );
  }

  const rawBaseUrl = e.HUBSPOT_BASE_URL === undefined || e.HUBSPOT_BASE_URL === null || String(e.HUBSPOT_BASE_URL).trim() === ''
    ? DEFAULT_HUBSPOT_BASE_URL
    : String(e.HUBSPOT_BASE_URL).trim();
  const hubspotBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  if (!/^https:\/\//i.test(hubspotBaseUrl)) {
    throw new Error('HUBSPOT_BASE_URL must use https:// (received "' + rawBaseUrl + '").');
  }

  const strategy = e.HISTORY_CORRUPT_STRATEGY === undefined || e.HISTORY_CORRUPT_STRATEGY === null || String(e.HISTORY_CORRUPT_STRATEGY).trim() === ''
    ? 'preserve'
    : String(e.HISTORY_CORRUPT_STRATEGY).trim().toLowerCase();
  if (HISTORY_CORRUPT_STRATEGIES.indexOf(strategy) === -1) {
    throw new Error('HISTORY_CORRUPT_STRATEGY must be one of: ' + HISTORY_CORRUPT_STRATEGIES.join(', ') + '.');
  }

  let sandboxPortalId = null;
  if (e.HUBSPOT_SANDBOX_PORTAL_ID !== undefined && e.HUBSPOT_SANDBOX_PORTAL_ID !== null) {
    const trimmed = String(e.HUBSPOT_SANDBOX_PORTAL_ID).trim();
    if (trimmed !== '' && trimmed.indexOf('REPLACE_WITH_') !== 0) {
      if (!/^\d+$/.test(trimmed)) throw new Error('HUBSPOT_SANDBOX_PORTAL_ID must be numeric.');
      sandboxPortalId = trimmed;
    }
  }

  return {
    dryRun: dryRun,
    sandboxMode: sandboxMode,
    allowProductionWrites: allowProductionWrites,
    writeMode: writeMode,
    hubspotBaseUrl: hubspotBaseUrl,
    sandboxPortalId: sandboxPortalId,
    maxTouchpoints: boundedInt(e.MAX_TOUCHPOINTS, 25, 1, 200, 'MAX_TOUCHPOINTS'),
    maxHistoryChars: boundedInt(e.MAX_HISTORY_CHARS, 60000, 1000, 65536, 'MAX_HISTORY_CHARS'),
    attributionWindowDays: boundedInt(e.ATTRIBUTION_WINDOW_DAYS, 30, 0, 365, 'ATTRIBUTION_WINDOW_DAYS'),
    protectLastTouchFromDirect: safetyFlag(e.PROTECT_LAST_TOUCH_FROM_DIRECT),
    historyCorruptStrategy: strategy,
    internalHosts: csvList(e.INTERNAL_HOSTS),
    lookupInDryRun: safetyFlag(e.LOOKUP_IN_DRY_RUN)
  };
}

function evaluateWriteTarget(cfg, account) {
  if (!cfg || cfg.writeMode === 'dry_run') return { allowed: false, reason: 'dry_run_enabled' };
  if (cfg.writeMode === 'production') {
    return cfg.allowProductionWrites
      ? { allowed: true, reason: 'production_writes_explicitly_allowed' }
      : { allowed: false, reason: 'production_writes_not_allowed' };
  }
  const accountType = String((account && account.accountType) || '').toUpperCase();
  if (SANDBOX_ACCOUNT_TYPES.indexOf(accountType) === -1) {
    return {
      allowed: false,
      reason: 'sandbox_mode_requires_sandbox_or_developer_test_account (received "' + (accountType || 'unknown') + '")'
    };
  }
  if (cfg.sandboxPortalId && String(account.portalId) !== cfg.sandboxPortalId) {
    return { allowed: false, reason: 'sandbox_portal_id_mismatch' };
  }
  return { allowed: true, reason: 'sandbox_account_verified' };
}
// </n8n-core:config>

const PLACEHOLDER_PREFIX = 'REPLACE_WITH_';

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  return trimmed === '' || trimmed.indexOf(PLACEHOLDER_PREFIX) === 0;
}

/**
 * Loads the full runtime config for the standalone Node.js engine.
 * Secrets are read here (not in parseConfig) so the n8n Code node never
 * touches tokens; n8n keeps them in its credential store instead.
 */
function loadConfig(env) {
  const source = env || process.env;
  const settings = parseConfig(source);
  const tokenVar = settings.sandboxMode ? 'HUBSPOT_SANDBOX_PRIVATE_APP_TOKEN' : 'HUBSPOT_PRIVATE_APP_TOKEN';
  const token = source[tokenVar];

  if (settings.writeMode !== 'dry_run' && isPlaceholder(token)) {
    throw new Error(
      'Refusing to start: write mode "' + settings.writeMode + '" requires ' + tokenVar +
      ' to be set to a real private app token (it is empty or still a REPLACE_WITH_ placeholder).'
    );
  }

  return Object.freeze(Object.assign({}, settings, {
    internalHosts: Object.freeze(settings.internalHosts.slice()),
    hubspotToken: isPlaceholder(token) ? null : String(token).trim(),
    hubspotTokenVar: tokenVar,
    webhookSecret: isPlaceholder(source.WEBHOOK_SECRET) ? null : String(source.WEBHOOK_SECRET),
    requireWebhookSignature: safetyFlag(source.REQUIRE_WEBHOOK_SIGNATURE),
    port: boundedInt(source.PORT, 8787, 1, 65535, 'PORT'),
    host: isPlaceholder(source.HOST) ? '127.0.0.1' : String(source.HOST).trim()
  }));
}

/** Returns a log-safe view of the config with secrets redacted. */
function describeConfig(cfg) {
  const view = Object.assign({}, cfg);
  view.hubspotToken = cfg.hubspotToken ? '[redacted]' : null;
  view.webhookSecret = cfg.webhookSecret ? '[redacted]' : null;
  return view;
}

module.exports = {
  CONFIG_KEYS,
  SANDBOX_ACCOUNT_TYPES,
  DEFAULT_HUBSPOT_BASE_URL,
  PLACEHOLDER_PREFIX,
  safetyFlag,
  optInFlag,
  boundedInt,
  csvList,
  parseConfig,
  evaluateWriteTarget,
  isPlaceholder,
  loadConfig,
  describeConfig
};
