'use strict';

/**
 * hubspot-mapper.js
 *
 * Builds the HubSpot Contact property payload for one normalized conversion
 * event. The rules I enforce:
 *
 *   First Touch (ft_*)  - write-once. Populated only when ft_timestamp is
 *                         empty/null. Never overwritten afterwards, even by an
 *                         older event that arrives late (that case is flagged).
 *   Last Touch (lt_*)   - overwritten on every qualifying event. An event is
 *                         not qualifying when it is older than the stored
 *                         lt_timestamp (out-of-order delivery).
 *   Direct protection   - optional: a direct / none session does not replace a
 *                         known source if the stored last touch is inside the
 *                         attribution window. latest_converting_asset still
 *                         updates, because the conversion itself is real.
 *   History             - utm_touchpoint_history is appended, deduped by event
 *                         ID, sorted, and capped. A duplicate event ID makes
 *                         the whole write a no-op, so webhook retries are safe.
 *
 * The region between the n8n-core:mapper markers is embedded verbatim into the
 * n8n workflow. It relies on isBlank() and appendTouchpoint() from the
 * normalizer core, which is always embedded before it.
 */

const { isBlank, appendTouchpoint } = require('./normalizer');

// <n8n-core:mapper>
const HUBSPOT_PROPERTIES = Object.freeze({
  email: 'email',
  ftSource: 'ft_utm_source',
  ftMedium: 'ft_utm_medium',
  ftCampaign: 'ft_utm_campaign',
  ftAsset: 'ft_converting_asset',
  ftTimestamp: 'ft_timestamp',
  ltSource: 'lt_utm_source',
  ltMedium: 'lt_utm_medium',
  ltCampaign: 'lt_utm_campaign',
  ltTimestamp: 'lt_timestamp',
  latestAsset: 'latest_converting_asset',
  history: 'utm_touchpoint_history'
});

const CONTACT_READ_PROPERTIES = Object.freeze([
  'email',
  'ft_utm_source',
  'ft_utm_medium',
  'ft_utm_campaign',
  'ft_converting_asset',
  'ft_timestamp',
  'lt_utm_source',
  'lt_utm_medium',
  'lt_utm_campaign',
  'lt_timestamp',
  'latest_converting_asset',
  'utm_touchpoint_history'
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function toEpochMs(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function isDirectTouch(source, medium) {
  const s = String(source || '').trim().toLowerCase();
  const m = String(medium || '').trim().toLowerCase();
  return (s === 'direct' || s === '(direct)') && (m === '' || m === 'none' || m === '(none)');
}

function mapperOptionsFromConfig(cfg) {
  const c = cfg || {};
  return {
    maxTouchpoints: c.maxTouchpoints,
    maxHistoryChars: c.maxHistoryChars,
    attributionWindowDays: c.attributionWindowDays,
    protectLastTouchFromDirect: c.protectLastTouchFromDirect,
    historyCorruptStrategy: c.historyCorruptStrategy
  };
}

function parseExistingIdFromConflict(body) {
  const message = body && typeof body === 'object' ? String(body.message || '') : String(body || '');
  const match = /Existing ID:\s*(\d+)/i.exec(message);
  return match ? match[1] : null;
}

function buildContactWrite(input) {
  const existing = input.existing || null;
  const event = input.event;
  const touchpoint = input.touchpoint;
  const defaults = {
    maxTouchpoints: 25,
    maxHistoryChars: 60000,
    attributionWindowDays: 30,
    protectLastTouchFromDirect: true,
    historyCorruptStrategy: 'preserve'
  };
  const opts = Object.assign({}, defaults);
  Object.keys(input.options || {}).forEach(function (key) {
    if (input.options[key] !== undefined && input.options[key] !== null) opts[key] = input.options[key];
  });

  const P = HUBSPOT_PROPERTIES;
  const current = existing && existing.properties ? existing.properties : {};
  const contactId = existing ? String(existing.id) : null;
  const properties = {};
  const warnings = [];
  const decisions = { firstTouch: null, lastTouch: null, history: null };
  const eventMs = toEpochMs(event.timestamp);

  // 1. Touchpoint history (also the idempotency check).
  let history = appendTouchpoint(current[P.history], touchpoint, {
    maxTouchpoints: opts.maxTouchpoints,
    maxChars: opts.maxHistoryChars
  });

  if (history.duplicate) {
    return {
      action: 'skip',
      reason: 'duplicate_event',
      contactId: contactId,
      properties: {},
      decisions: { firstTouch: 'unchanged', lastTouch: 'unchanged', history: 'duplicate' },
      warnings: warnings,
      historyLength: history.history.length,
      droppedTouchpoints: 0
    };
  }

  if (history.status === 'corrupt') {
    if (opts.historyCorruptStrategy === 'reset') {
      warnings.push('history_corrupt_reset_to_new_array');
      history = appendTouchpoint(null, touchpoint, { maxTouchpoints: opts.maxTouchpoints, maxChars: opts.maxHistoryChars });
      decisions.history = 'reset';
    } else {
      warnings.push('history_corrupt_preserved_not_written');
      decisions.history = 'preserved_corrupt_value';
    }
  }

  if (history.status === 'oversize') {
    warnings.push('touchpoint_exceeds_max_history_chars_not_written');
    decisions.history = 'oversize_not_written';
  } else if (history.status !== 'corrupt') {
    if (history.status === 'sanitized') warnings.push('history_contained_invalid_entries_removed');
    if (history.dropped > 0) warnings.push('history_capped_dropped_' + history.dropped + '_oldest');
    if (!history.retained) warnings.push('event_older_than_capped_history_window');
    if (history.changed) {
      properties[P.history] = history.serialized;
      if (!decisions.history) decisions.history = 'appended';
    } else if (!decisions.history) {
      decisions.history = 'unchanged';
    }
  }

  // 2. First Touch: write-once, gated strictly on ft_timestamp.
  if (isBlank(current[P.ftTimestamp])) {
    properties[P.ftSource] = event.utm_source;
    properties[P.ftMedium] = event.utm_medium;
    properties[P.ftCampaign] = event.utm_campaign || '';
    properties[P.ftAsset] = event.converting_asset;
    properties[P.ftTimestamp] = String(eventMs);
    decisions.firstTouch = 'set';
  } else {
    decisions.firstTouch = 'preserved';
    const ftMs = toEpochMs(current[P.ftTimestamp]);
    if (ftMs !== null && eventMs < ftMs) warnings.push('event_older_than_existing_first_touch_not_overwritten');
  }

  // 3. Last Touch: mutable, with out-of-order and direct-traffic protection.
  const ltMs = toEpochMs(current[P.ltTimestamp]);
  if (ltMs !== null && eventMs < ltMs) {
    decisions.lastTouch = 'stale_event_not_applied';
  } else {
    properties[P.latestAsset] = event.converting_asset;
    const windowMs = Number(opts.attributionWindowDays) * DAY_MS;
    const protect = Boolean(opts.protectLastTouchFromDirect) &&
      isDirectTouch(event.utm_source, event.utm_medium) &&
      !isBlank(current[P.ltSource]) &&
      !isDirectTouch(current[P.ltSource], current[P.ltMedium]) &&
      ltMs !== null &&
      (eventMs - ltMs) <= windowMs;

    if (protect) {
      decisions.lastTouch = 'protected_known_source_within_window';
    } else {
      properties[P.ltSource] = event.utm_source;
      properties[P.ltMedium] = event.utm_medium;
      properties[P.ltCampaign] = event.utm_campaign || '';
      properties[P.ltTimestamp] = String(eventMs);
      decisions.lastTouch = 'set';
    }
  }

  // 4. Drop no-op writes so retries and replays cost nothing.
  if (existing) {
    Object.keys(properties).forEach(function (key) {
      if (key === P.ftTimestamp || key === P.ltTimestamp) {
        // HubSpot returns datetimes as ISO strings; I write epoch milliseconds.
        if (toEpochMs(current[key]) === toEpochMs(properties[key])) delete properties[key];
        return;
      }
      const before = current[key] === undefined || current[key] === null ? '' : String(current[key]);
      if (before === String(properties[key])) delete properties[key];
    });
  } else {
    properties[P.email] = event.email;
  }

  const result = {
    action: existing ? 'update' : 'create',
    reason: null,
    contactId: contactId,
    properties: properties,
    decisions: decisions,
    warnings: warnings,
    historyLength: history.status === 'corrupt' || history.status === 'oversize' ? null : history.history.length,
    droppedTouchpoints: history.dropped || 0
  };

  if (Object.keys(properties).length === 0) {
    result.action = 'skip';
    result.reason = 'no_changes';
  }
  return result;
}
// </n8n-core:mapper>

module.exports = {
  HUBSPOT_PROPERTIES,
  CONTACT_READ_PROPERTIES,
  toEpochMs,
  isDirectTouch,
  mapperOptionsFromConfig,
  parseExistingIdFromConflict,
  buildContactWrite
};
