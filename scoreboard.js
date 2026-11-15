'use strict';
/**
 * scoreboard.js — n8n-hubspot-sales-rep-activity-quota-scoreboard
 * License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
 *
 * Tallies logged calls, sent emails and booked (or held) meetings per HubSpot owner
 * over a reporting window, scales daily quotas to the window's working days, scores
 * attainment, ranks reps and formats a Slack Block Kit scoreboard.
 *
 * HOW IT RUNS
 * - In n8n: each Code node in workflow.json contains this whole file, preceded by one
 *   line such as `const SYNDICATOR_STAGE = 'score';`. That line selects what the node does
 *   (see runStage). If you edit this file, paste it into every Code node again and keep
 *   each node's first line.
 * - In Node.js: `require('./scoreboard.js')` exports the pure functions. Nothing runs on require.
 *
 * SAFETY
 * - HubSpot access is read-only (owners list + CRM search).
 * - DRY_RUN=true (default): the scoreboard is built and shown in n8n; nothing is posted to Slack.
 * - Slack webhook URLs are read from $env by the HTTP node and never enter item data.
 * - Every error passes through maskSecrets()/maskError() (tokens, auth headers, webhook URLs, emails, phones).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SECRET_KEYS = ['HUBSPOT_ACCESS_TOKEN', 'SLACK_WEBHOOK_URLS', 'ALERT_WEBHOOK_URL'];
const CONFIG_KEYS = SECRET_KEYS.concat([
  'DRY_RUN', 'HUBSPOT_API_BASE', 'REPORT_WINDOW', 'REPORT_TIMEZONE', 'COUNT_WEEKENDS',
  'REP_OWNER_IDS', 'REP_TEAM_IDS', 'EXCLUDE_OWNER_IDS', 'INCLUDE_ZERO_ACTIVITY_REPS',
  'DAILY_TARGET_CALLS', 'DAILY_TARGET_EMAILS', 'DAILY_TARGET_MEETINGS', 'QUOTA_OVERRIDES_JSON',
  'WEIGHT_CALLS', 'WEIGHT_EMAILS', 'WEIGHT_MEETINGS', 'ATTAINMENT_CAP',
  'POINTS_CALL', 'POINTS_CONNECTED_CALL', 'POINTS_EMAIL', 'POINTS_MEETING',
  'CONNECTED_CALL_MIN_SECONDS', 'MEETING_COUNT_MODE', 'RANK_BY', 'MAX_REPS_SHOWN', 'NAME_FORMAT',
  'SCOREBOARD_TITLE',
]);
const WINDOWS = ['previous_business_day', 'yesterday', 'today', 'last_week', 'week_to_date', 'month_to_date'];
const RANK_FIELDS = ['attainment', 'points', 'meetings', 'calls', 'emails'];
const NAME_FORMATS = ['full', 'first_last_initial', 'initials'];
const DAY = 86400000;

function parseBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Placeholders such as YOUR_SLACK_WEBHOOK_URL count as "not set". */
function cleanValue(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  return /^YOUR_[A-Z0-9_]+$/.test(s) ? '' : s;
}

function num(value, fallback) {
  const s = cleanValue(value);
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function idList(value) {
  return cleanValue(value).split(/[\s,]+/).filter(Boolean);
}

/** Slack webhook URLs (comma-separated). Only their count leaves this function. */
function slackWebhookUrls(value) {
  return cleanValue(value).split(',').map((u) => u.trim()).filter((u) => u && !/^YOUR_/.test(u));
}

/**
 * Per-rep quota overrides. Keys are HubSpot owner IDs or owner emails; values are
 * daily targets, e.g. {"12345": {"calls": 40}, "rep_1@example.com": {"meetings": 3}}.
 */
function parseQuotaOverrides(raw, errors) {
  const s = cleanValue(raw);
  if (!s) return {};
  let obj;
  try { obj = JSON.parse(s); } catch (e) { errors.push('QUOTA_OVERRIDES_JSON is not valid JSON'); return {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { errors.push('QUOTA_OVERRIDES_JSON must be an object keyed by owner ID or email'); return {}; }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') { errors.push('QUOTA_OVERRIDES_JSON["' + k + '"] must be an object'); continue; }
    const t = {};
    for (const f of ['calls', 'emails', 'meetings']) {
      if (v[f] === undefined) continue;
      const x = Number(v[f]);
      if (!(x >= 0 && x <= 1000)) errors.push('QUOTA_OVERRIDES_JSON["' + k + '"].' + f + ' must be 0-1000');
      else t[f] = x;
    }
    out[String(k).toLowerCase()] = t;
  }
  return out;
}

/**
 * Resolve settings from an env-like object. `settings` contains no secrets and no
 * webhook URLs (only presence flags and a channel count), so it is safe in item data.
 */
function resolveConfig(env) {
  const e = env || {};
  const errors = [];
  const s = {
    dryRun: parseBool(e.DRY_RUN, true),
    hubspotApiBase: String(cleanValue(e.HUBSPOT_API_BASE) || 'https://api.hubapi.com').replace(/\/+$/, ''),
    reportWindow: String(cleanValue(e.REPORT_WINDOW) || 'previous_business_day').toLowerCase(),
    reportTimezone: cleanValue(e.REPORT_TIMEZONE) || 'UTC',
    countWeekends: parseBool(e.COUNT_WEEKENDS, false),
    repOwnerIds: idList(e.REP_OWNER_IDS),
    repTeamIds: idList(e.REP_TEAM_IDS),
    excludeOwnerIds: idList(e.EXCLUDE_OWNER_IDS),
    includeZeroActivityReps: parseBool(e.INCLUDE_ZERO_ACTIVITY_REPS, true),
    dailyTargets: { calls: num(e.DAILY_TARGET_CALLS, 30), emails: num(e.DAILY_TARGET_EMAILS, 40), meetings: num(e.DAILY_TARGET_MEETINGS, 2) },
    weights: { calls: num(e.WEIGHT_CALLS, 0.3), emails: num(e.WEIGHT_EMAILS, 0.2), meetings: num(e.WEIGHT_MEETINGS, 0.5) },
    attainmentCap: num(e.ATTAINMENT_CAP, 1.5),
    points: { call: num(e.POINTS_CALL, 1), connectedCall: num(e.POINTS_CONNECTED_CALL, 2), email: num(e.POINTS_EMAIL, 0.5), meeting: num(e.POINTS_MEETING, 5) },
    connectedCallMinSeconds: num(e.CONNECTED_CALL_MIN_SECONDS, 60),
    meetingCountMode: String(cleanValue(e.MEETING_COUNT_MODE) || 'booked').toLowerCase(),
    rankBy: String(cleanValue(e.RANK_BY) || 'attainment').toLowerCase(),
    maxRepsShown: num(e.MAX_REPS_SHOWN, 20),
    nameFormat: String(cleanValue(e.NAME_FORMAT) || 'first_last_initial').toLowerCase(),
    title: cleanValue(e.SCOREBOARD_TITLE) || 'Sales activity scoreboard',
    slackChannelCount: slackWebhookUrls(e.SLACK_WEBHOOK_URLS).length,
    present: { hubspotAccessToken: cleanValue(e.HUBSPOT_ACCESS_TOKEN) !== '', alertWebhookUrl: cleanValue(e.ALERT_WEBHOOK_URL) !== '' },
  };
  s.quotaOverrides = parseQuotaOverrides(e.QUOTA_OVERRIDES_JSON, errors);

  if (!s.present.hubspotAccessToken) errors.push('HUBSPOT_ACCESS_TOKEN is not set (placeholders count as unset)');
  if (!/^https:\/\//i.test(s.hubspotApiBase)) errors.push('HUBSPOT_API_BASE must use https://');
  if (!WINDOWS.includes(s.reportWindow)) errors.push('REPORT_WINDOW must be one of ' + WINDOWS.join(', '));
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.reportTimezone }); } catch (err) { errors.push('REPORT_TIMEZONE is not a valid IANA time zone'); }
  for (const [label, list] of [['REP_OWNER_IDS', s.repOwnerIds], ['REP_TEAM_IDS', s.repTeamIds], ['EXCLUDE_OWNER_IDS', s.excludeOwnerIds]]) {
    if (list.some((x) => !/^\d{1,20}$/.test(x))) errors.push(label + ' must be comma-separated numeric IDs');
  }
  if (s.repOwnerIds.length > 100) errors.push('REP_OWNER_IDS supports at most 100 owners (HubSpot search IN filter limit)');
  for (const [k, v] of Object.entries(s.dailyTargets)) if (!(v >= 0 && v <= 1000)) errors.push('DAILY_TARGET_' + k.toUpperCase() + ' must be a number from 0 to 1000');
  const w = Object.values(s.weights);
  if (w.some((x) => !(x >= 0 && x <= 10))) errors.push('WEIGHT_* values must be numbers from 0 to 10');
  else if (w.reduce((a, b) => a + b, 0) <= 0) errors.push('At least one WEIGHT_* value must be greater than 0');
  if (!(s.attainmentCap >= 1 && s.attainmentCap <= 5)) errors.push('ATTAINMENT_CAP must be between 1 and 5');
  if (Object.values(s.points).some((x) => !(x >= 0 && x <= 100))) errors.push('POINTS_* values must be numbers from 0 to 100');
  if (!(Number.isInteger(s.connectedCallMinSeconds) && s.connectedCallMinSeconds >= 0 && s.connectedCallMinSeconds <= 3600)) errors.push('CONNECTED_CALL_MIN_SECONDS must be an integer from 0 to 3600');
  if (!['booked', 'held'].includes(s.meetingCountMode)) errors.push('MEETING_COUNT_MODE must be booked or held');
  if (!RANK_FIELDS.includes(s.rankBy)) errors.push('RANK_BY must be one of ' + RANK_FIELDS.join(', '));
  if (!(Number.isInteger(s.maxRepsShown) && s.maxRepsShown >= 1 && s.maxRepsShown <= 40)) errors.push('MAX_REPS_SHOWN must be an integer from 1 to 40');
  if (!NAME_FORMATS.includes(s.nameFormat)) errors.push('NAME_FORMAT must be one of ' + NAME_FORMATS.join(', '));
  if (!s.dryRun && s.slackChannelCount === 0) errors.push('SLACK_WEBHOOK_URLS needs at least one Slack incoming webhook URL when DRY_RUN=false');
  if (slackWebhookUrls(e.SLACK_WEBHOOK_URLS).some((u) => !/^https:\/\//i.test(u))) errors.push('Every SLACK_WEBHOOK_URLS entry must use https://');
  if (s.slackChannelCount > 10) errors.push('SLACK_WEBHOOK_URLS supports at most 10 channels');
  return { settings: s, errors };
}

// ---------------------------------------------------------------------------
// Reporting window (time-zone aware)
// ---------------------------------------------------------------------------

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { y: +g('year'), m: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute'), s: +g('second'), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
}

/** UTC epoch ms of local midnight (y-m-d 00:00) in timeZone, DST-safe. */
function localMidnightUtc(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  let ts = guess;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(ts, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const offset = asUtc - ts;
    const next = guess - offset;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

function addDays(dayUtc, n) {
  return dayUtc + n * DAY;
}

function dayLabel(dayUtc) {
  return new Date(dayUtc).toISOString().slice(0, 10);
}

function workingDays(startDayUtc, endDayExclusiveUtc, countWeekends) {
  let n = 0;
  for (let d = startDayUtc; d < endDayExclusiveUtc; d += DAY) {
    const wd = new Date(d).getUTCDay();
    if (countWeekends || (wd !== 0 && wd !== 6)) n++;
  }
  return n;
}

/**
 * Reporting window: { startMs, endMs (exclusive), label, startDay, endDay, workingDays, partial }.
 * Day arithmetic is done on calendar dates; boundaries are converted to UTC for HubSpot.
 */
function computeWindow(now, s) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const p = zonedParts(nowMs, s.reportTimezone);
  const today = Date.UTC(p.y, p.m - 1, p.d);
  const wd = p.weekday;
  let startDay;
  let endDayExcl;
  let partial = false;
  switch (s.reportWindow) {
    case 'yesterday': startDay = addDays(today, -1); endDayExcl = today; break;
    case 'today': startDay = today; endDayExcl = addDays(today, 1); partial = true; break;
    case 'last_week': { const monday = addDays(today, -((wd + 6) % 7)); startDay = addDays(monday, -7); endDayExcl = monday; break; }
    case 'week_to_date': startDay = addDays(today, -((wd + 6) % 7)); endDayExcl = addDays(today, 1); partial = true; break;
    case 'month_to_date': startDay = Date.UTC(p.y, p.m - 1, 1); endDayExcl = addDays(today, 1); partial = true; break;
    default: { // previous_business_day
      let d = addDays(today, -1);
      if (!s.countWeekends) while ([0, 6].includes(new Date(d).getUTCDay())) d = addDays(d, -1);
      startDay = d; endDayExcl = addDays(d, 1);
    }
  }
  const toUtc = (dayUtc) => { const x = new Date(dayUtc); return localMidnightUtc(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), s.reportTimezone); };
  const startMs = toUtc(startDay);
  const endMs = partial ? Math.min(toUtc(endDayExcl), nowMs) : toUtc(endDayExcl);
  const startLabel = dayLabel(startDay);
  const endLabel = dayLabel(addDays(endDayExcl, -1));
  return {
    window: s.reportWindow, timezone: s.reportTimezone, startMs, endMs, startDay: startLabel, endDay: endLabel,
    label: startLabel === endLabel ? startLabel : startLabel + ' – ' + endLabel,
    workingDays: workingDays(startDay, endDayExcl, s.countWeekends), partial,
  };
}

// ---------------------------------------------------------------------------
// HubSpot search request bodies
// ---------------------------------------------------------------------------

const PAGE_SIZE = 200; // CRM search maximum per page

function ownerFilter(s) {
  return s.repOwnerIds.length
    ? { propertyName: 'hubspot_owner_id', operator: 'IN', values: s.repOwnerIds }
    : { propertyName: 'hubspot_owner_id', operator: 'HAS_PROPERTY' };
}

function rangeFilters(property, w) {
  return [
    { propertyName: property, operator: 'GTE', value: String(w.startMs) },
    { propertyName: property, operator: 'LT', value: String(w.endMs) },
  ];
}

/** Search bodies for calls, outgoing emails and meetings (booked = created in window, held = started in window). */
function buildSearchBodies(w, s) {
  const owner = ownerFilter(s);
  return {
    calls: {
      filterGroups: [{ filters: rangeFilters('hs_timestamp', w).concat([owner]) }],
      properties: ['hubspot_owner_id', 'hs_timestamp', 'hs_call_duration', 'hs_call_direction', 'hs_call_status'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: PAGE_SIZE,
    },
    emails: {
      filterGroups: [{ filters: rangeFilters('hs_timestamp', w).concat([owner, { propertyName: 'hs_email_direction', operator: 'EQ', value: 'EMAIL' }]) }],
      properties: ['hubspot_owner_id', 'hs_timestamp', 'hs_email_direction', 'hs_email_status'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: PAGE_SIZE,
    },
    meetings: {
      filterGroups: [{ filters: rangeFilters(s.meetingCountMode === 'held' ? 'hs_meeting_start_time' : 'hs_createdate', w).concat([owner]) }],
      properties: ['hubspot_owner_id', 'hs_timestamp', 'hs_createdate', 'hs_meeting_start_time', 'hs_meeting_outcome'],
      sorts: [{ propertyName: s.meetingCountMode === 'held' ? 'hs_meeting_start_time' : 'hs_createdate', direction: 'ASCENDING' }],
      limit: PAGE_SIZE,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalisation and aggregation
// ---------------------------------------------------------------------------

function flattenResults(pages) {
  const out = [];
  let reportedTotal = 0;
  for (const p of pages || []) {
    if (!p) continue;
    if (Array.isArray(p.results)) out.push(...p.results);
    if (Number.isFinite(Number(p.total))) reportedTotal = Math.max(reportedTotal, Number(p.total));
  }
  const seen = new Set();
  const unique = out.filter((r) => r && r.id && !seen.has(String(r.id)) && seen.add(String(r.id)));
  return { results: unique, reportedTotal, truncated: reportedTotal > 10000 };
}

/** Canonical activity: { type, id, ownerId, ts, connected? }. */
function normalizeActivity(type, rec, s) {
  const p = (rec && rec.properties) || {};
  const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
  const a = { type, id: String(rec.id), ownerId };
  if (type === 'calls') {
    const ms = Number(p.hs_call_duration);
    a.connected = Number.isFinite(ms) && ms >= s.connectedCallMinSeconds * 1000;
  }
  if (type === 'meetings') {
    const outcome = String(p.hs_meeting_outcome || '').toUpperCase();
    a.countable = s.meetingCountMode === 'held' ? !['CANCELED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(outcome) : outcome !== 'CANCELED' && outcome !== 'CANCELLED';
  }
  return a;
}

function displayName(owner, format) {
  const first = String(owner.firstName || '').trim();
  const last = String(owner.lastName || '').trim();
  if (!first && !last) return 'Owner ' + owner.id;
  if (format === 'full') return (first + ' ' + last).trim();
  if (format === 'initials') return ((first[0] || '') + (last[0] || '')).toUpperCase() || 'Owner ' + owner.id;
  return (first || last) + (first && last ? ' ' + last[0].toUpperCase() + '.' : '');
}

function targetsFor(owner, s, days) {
  const o = s.quotaOverrides[String(owner.id)] || (owner.email ? s.quotaOverrides[String(owner.email).toLowerCase()] : null) || {};
  const daily = Object.assign({}, s.dailyTargets, o);
  return { calls: daily.calls * days, emails: daily.emails * days, meetings: daily.meetings * days };
}

function ratio(actual, target, cap) {
  if (!(target > 0)) return null;
  return Math.min(cap, actual / target);
}

/**
 * Build the scoreboard model.
 * input: { owners (HubSpot owner objects), calls/emails/meetings (search page bodies), window }
 */
function buildScoreboard(input, s) {
  const i = input || {};
  const w = i.window;
  const ownersById = {};
  for (const o of i.owners || []) {
    if (!o || o.id === undefined || o.archived === true) continue;
    ownersById[String(o.id)] = { id: String(o.id), firstName: o.firstName || '', lastName: o.lastName || '', email: o.email || null, teams: (o.teams || []).map((t) => String(t.id)) };
  }
  const data = {};
  const quality = { truncated: [], emailsWithoutOwner: 0, unknownOwners: 0 };
  for (const type of ['calls', 'emails', 'meetings']) {
    const f = flattenResults(i[type]);
    if (f.truncated) quality.truncated.push(type);
    data[type] = f.results.map((r) => normalizeActivity(type, r, s));
    if (type === 'emails') quality.emailsWithoutOwner = data[type].filter((a) => !a.ownerId).length;
  }

  const inScope = (ownerId) => {
    if (s.excludeOwnerIds.includes(ownerId)) return false;
    if (s.repOwnerIds.length && !s.repOwnerIds.includes(ownerId)) return false;
    if (s.repTeamIds.length) {
      const o = ownersById[ownerId];
      if (!o || !o.teams.some((t) => s.repTeamIds.includes(t))) return false;
    }
    return true;
  };

  const reps = {};
  const rep = (ownerId) => {
    if (!reps[ownerId]) {
      const o = ownersById[ownerId] || { id: ownerId, firstName: '', lastName: '', email: null, teams: [] };
      if (!ownersById[ownerId]) quality.unknownOwners++;
      reps[ownerId] = { ownerId, name: displayName(o, s.nameFormat), owner: o, calls: 0, connectedCalls: 0, emails: 0, meetings: 0 };
    }
    return reps[ownerId];
  };
  for (const a of data.calls) if (a.ownerId && inScope(a.ownerId)) { const r = rep(a.ownerId); r.calls++; if (a.connected) r.connectedCalls++; }
  for (const a of data.emails) if (a.ownerId && inScope(a.ownerId)) rep(a.ownerId).emails++;
  for (const a of data.meetings) if (a.ownerId && a.countable && inScope(a.ownerId)) rep(a.ownerId).meetings++;

  if (s.includeZeroActivityReps) {
    const roster = s.repOwnerIds.length ? s.repOwnerIds
      : s.repTeamIds.length ? Object.values(ownersById).filter((o) => o.teams.some((t) => s.repTeamIds.includes(t))).map((o) => o.id) : [];
    for (const id of roster) if (inScope(id)) rep(id);
  }

  const wsum = s.weights.calls + s.weights.emails + s.weights.meetings;
  const list = Object.values(reps).map((r) => {
    const t = targetsFor(r.owner, s, w.workingDays);
    const att = { calls: ratio(r.calls, t.calls, s.attainmentCap), emails: ratio(r.emails, t.emails, s.attainmentCap), meetings: ratio(r.meetings, t.meetings, s.attainmentCap) };
    let weighted = 0;
    let den = 0;
    for (const k of ['calls', 'emails', 'meetings']) if (att[k] !== null) { weighted += s.weights[k] * att[k]; den += s.weights[k]; }
    const attainment = den > 0 ? weighted / den : null;
    const points = r.calls * s.points.call + r.connectedCalls * s.points.connectedCall + r.emails * s.points.email + r.meetings * s.points.meeting;
    return {
      ownerId: r.ownerId, name: r.name, calls: r.calls, connectedCalls: r.connectedCalls, emails: r.emails, meetings: r.meetings,
      targets: t, attainmentByType: att, attainment: attainment === null ? null : Math.round(attainment * 1000) / 1000,
      points: Math.round(points * 10) / 10, totalActivities: r.calls + r.emails + r.meetings,
    };
  });
  const key = s.rankBy;
  list.sort((a, b) => ((b[key] === null ? -1 : b[key]) - (a[key] === null ? -1 : a[key])) || b.points - a.points || b.totalActivities - a.totalActivities || (a.name < b.name ? -1 : 1));
  list.forEach((r, idx) => { r.rank = idx + 1; });

  const sum = (f) => list.reduce((a, r) => a + r[f], 0);
  const scored = list.filter((r) => r.attainment !== null);
  return {
    window: w,
    weightsTotal: wsum,
    rankBy: s.rankBy,
    meetingCountMode: s.meetingCountMode,
    reps: list,
    team: {
      reps: list.length,
      calls: sum('calls'), connectedCalls: sum('connectedCalls'), emails: sum('emails'), meetings: sum('meetings'),
      avgAttainment: scored.length ? Math.round((scored.reduce((a, r) => a + r.attainment, 0) / scored.length) * 1000) / 1000 : null,
      onTarget: scored.filter((r) => r.attainment >= 1).length,
      atRisk: scored.filter((r) => r.attainment < 0.7).length,
    },
    quality,
  };
}

// ---------------------------------------------------------------------------
// Slack Block Kit
// ---------------------------------------------------------------------------

function esc(text) {
  return String(text === undefined || text === null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtInt(v) {
  return Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(r) {
  return r === null || r === undefined ? 'n/a' : Math.round(r * 100) + '%';
}

/** 10-segment progress bar, e.g. ▰▰▰▰▰▰▰▱▱▱; values above 100% fill the bar. */
function progressBar(r, width) {
  const w = width || 10;
  if (r === null || r === undefined) return '▱'.repeat(w);
  const filled = Math.max(0, Math.min(w, Math.round(Math.min(1, r) * w)));
  return '▰'.repeat(filled) + '▱'.repeat(w - filled);
}

function statusEmoji(r) {
  if (r === null || r === undefined) return '⚪';
  if (r >= 1) return '🟢';
  if (r >= 0.7) return '🟡';
  return '🔴';
}

const MEDALS = ['🥇', '🥈', '🥉'];

function fmtDateRange(w) {
  const f = (iso, withYear) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', Object.assign({ weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }, withYear ? { year: 'numeric' } : {}));
  return w.startDay === w.endDay ? f(w.startDay, true) : f(w.startDay, false) + ' – ' + f(w.endDay, true);
}

function repLine(r, s) {
  const prefix = r.rank <= 3 ? MEDALS[r.rank - 1] : '`' + String(r.rank).padStart(2, ' ') + '`';
  const head = prefix + ' *' + esc(r.name) + '*  ' + statusEmoji(r.attainment) + ' ' + progressBar(r.attainment) + ' *' + fmtPct(r.attainment) + '*';
  const t = r.targets;
  const part = (emoji, actual, target) => emoji + ' ' + fmtInt(actual) + (target > 0 ? '/' + fmtInt(target) : '');
  return head + '\n' + [
    part('📞', r.calls, t.calls) + (r.connectedCalls ? ' (' + fmtInt(r.connectedCalls) + ' connected)' : ''),
    part('✉️', r.emails, t.emails),
    part('📅', r.meetings, t.meetings),
    '⭐ ' + r.points + ' pts',
  ].join('  ·  ');
}

const RANK_LABELS = { attainment: 'quota attainment', points: 'activity points', meetings: 'meetings', calls: 'calls', emails: 'emails' };

/** Slack incoming-webhook payload: <= 50 blocks, <= 3000 chars per text, header <= 150 chars. */
function buildSlackPayload(board, s) {
  const b = board;
  const w = b.window;
  const title = (s.dryRun ? '[DRY RUN] ' : '') + '🏁 ' + s.title + ' · ' + fmtDateRange(w);
  const t = b.team;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*📞 Calls*\n' + fmtInt(t.calls) + (t.connectedCalls ? ' (' + fmtInt(t.connectedCalls) + ' connected)' : '') },
        { type: 'mrkdwn', text: '*✉️ Emails sent*\n' + fmtInt(t.emails) },
        { type: 'mrkdwn', text: '*📅 Meetings ' + (b.meetingCountMode === 'held' ? 'held' : 'booked') + '*\n' + fmtInt(t.meetings) },
        { type: 'mrkdwn', text: '*🎯 Team attainment*\n' + statusEmoji(t.avgAttainment) + ' ' + fmtPct(t.avgAttainment) + ' · ' + t.onTarget + ' on target · ' + t.atRisk + ' at risk' },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: esc(w.timezone) + ' · ' + w.workingDays + ' working day' + (w.workingDays === 1 ? '' : 's') + (w.partial ? ' (period in progress)' : '') + ' · ' + t.reps + ' reps · ranked by ' + RANK_LABELS[b.rankBy] }] },
    { type: 'divider' },
  ];
  if (w.workingDays === 0) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No working days in this window, so quotas are not scored._' } });
  if (!b.reps.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No logged calls, emails or meetings for the selected reps in this window._' } });
  const shown = b.reps.slice(0, s.maxRepsShown);
  // Two reps per section keeps long teams inside Slack's 50-block limit.
  for (let k = 0; k < shown.length; k += 2) {
    const text = shown.slice(k, k + 2).map((r) => repLine(r, s)).join('\n\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } });
  }
  if (b.reps.length > shown.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '+' + (b.reps.length - shown.length) + ' more reps not shown (MAX_REPS_SHOWN=' + s.maxRepsShown + ')' }] });
  const notes = [];
  if (b.quality.emailsWithoutOwner) notes.push(':warning: ' + b.quality.emailsWithoutOwner + ' emails had no owner. Add the `sales-email-read` scope so HubSpot does not redact email owner data.');
  if (b.quality.truncated.length) notes.push(':warning: HubSpot search returns at most 10,000 records; ' + b.quality.truncated.join(', ') + ' were truncated. Use a shorter window.');
  if (notes.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join('\n').slice(0, 2900) }] });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🟢 ≥100% · 🟡 70–99% · 🔴 <70% of quota · Targets scale with working days · Source: HubSpot CRM activities' }] });
  const leader = b.reps[0];
  const fallback = esc(title + ': ' + fmtInt(t.calls) + ' calls, ' + fmtInt(t.emails) + ' emails, ' + fmtInt(t.meetings) + ' meetings' +
    (leader ? '. Leader: ' + leader.name + ' (' + fmtPct(leader.attainment) + ')' : ''));
  return { text: fallback, blocks: blocks.slice(0, 50), unfurl_links: false, unfurl_media: false };
}

// ---------------------------------------------------------------------------
// Masked logging
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, '$1 ***'],
  [/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]{8,}/gi, 'pat-***'],
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, 'https://hooks.slack.com/***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/([?&](?:token|hapikey|api_key|access_token)=)[^&\s"']+/gi, '$1***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
  [/\+?\(?\d{1,4}\)?[\s.-]?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{0,4}\b/g, '***phone***'],
];

function maskSecrets(text, secretValues) {
  let out = text === undefined || text === null ? '' : String(text);
  const values = (secretValues || []).filter((v) => typeof v === 'string' && v.length >= 6).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('***');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function maskError(errLike, secretValues) {
  let message;
  let status = null;
  if (errLike === undefined || errLike === null) message = 'Unknown error';
  else if (typeof errLike === 'string') message = errLike;
  else {
    status = errLike.httpCode || errLike.status || errLike.statusCode || null;
    message = errLike.message || errLike.description || '';
    if (!message) { try { message = JSON.stringify(errLike); } catch (_) { message = String(errLike); } }
  }
  let m = maskSecrets(message, secretValues);
  if (String(status) === '403' || /\b403\b/.test(m)) {
    m += ' — hint: calls/meetings search needs crm.objects.contacts.read, emails also need sales-email-read, owners need crm.objects.owners.read.';
  }
  if (String(status) === '429' || /\b429\b/.test(m)) m += ' — hint: HubSpot search is rate limited; the workflow already paces requests, try again later.';
  return { status: status === null ? null : String(status), message: m.length > 1200 ? m.slice(0, 1199) + '…' : m };
}

// ---------------------------------------------------------------------------
// n8n stages
// ---------------------------------------------------------------------------

function readEnv(keys) {
  const env = {};
  for (const k of keys) {
    let v;
    try { v = $env[k]; } catch (e) {
      throw new Error('This workflow reads its configuration from environment variables. Set N8N_BLOCK_ENV_ACCESS_IN_NODE=false on the n8n instance.');
    }
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

function allJson(nodeName) {
  try {
    const node = $(nodeName);
    if (node.isExecuted === false) return [];
    return node.all().map((i) => i.json);
  } catch (e) {
    return [];
  }
}

function runStage(stage) {
  if (stage === 'gate') {
    const { settings, errors } = resolveConfig(readEnv(CONFIG_KEYS));
    if (errors.length) throw new Error('Configuration invalid: ' + errors.join('; '));
    const window = computeWindow(new Date(), settings);
    return [{ json: { config: settings, window, searchBodies: buildSearchBodies(window, settings), startedAt: new Date().toISOString() } }];
  }

  if (stage === 'score') {
    const gate = $('Config & Window').first().json;
    const owners = allJson('HubSpot: List Owners').flatMap((p) => (p && p.results) || []);
    const board = buildScoreboard({
      window: gate.window,
      owners,
      calls: allJson('HubSpot: Search Calls'),
      emails: allJson('HubSpot: Search Emails'),
      meetings: allJson('HubSpot: Search Meetings'),
    }, gate.config);
    return [{ json: { scoreboard: board, slackPayload: buildSlackPayload(board, gate.config) } }];
  }

  if (stage === 'slack-items') {
    const gate = $('Config & Window').first().json;
    const { slackPayload } = $('Score Reps & Build Scoreboard').first().json;
    // One item per channel; the HTTP node resolves each webhook URL from $env by index.
    return Array.from({ length: gate.config.slackChannelCount }, (_, i) => ({ json: { channelIndex: i, slackPayload } }));
  }

  if (stage === 'logger') {
    const secrets = [];
    for (const k of SECRET_KEYS) {
      try { const v = cleanValue($env[k]); if (v) secrets.push(v, ...v.split(',').map((x) => x.trim())); } catch (e) { /* blocked */ }
    }
    let source = 'unknown node';
    try { source = $prevNode.name; } catch (e) { /* not available */ }
    return $input.all().map((item) => {
      const j = item.json || {};
      const masked = maskError(j.error !== undefined ? j.error : j, secrets);
      return { json: {
        node: source, status: masked.status, message: masked.message, at: new Date().toISOString(),
        alert: { text: 'Scoreboard error at ' + source + (masked.status ? ' (HTTP ' + masked.status + ')' : '') + ': ' + masked.message },
      } };
    });
  }

  throw new Error('Unknown SYNDICATOR_STAGE: ' + stage);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG_KEYS, SECRET_KEYS, WINDOWS, RANK_FIELDS,
    parseBool, cleanValue, slackWebhookUrls, parseQuotaOverrides, resolveConfig,
    zonedParts, localMidnightUtc, computeWindow, buildSearchBodies, flattenResults, normalizeActivity, displayName,
    targetsFor, buildScoreboard, progressBar, statusEmoji, fmtPct, buildSlackPayload, esc, maskSecrets, maskError, runStage,
  };
}

// n8n entry point: the Code node defines SYNDICATOR_STAGE on its first line.
if (typeof SYNDICATOR_STAGE !== 'undefined') {
  return runStage(SYNDICATOR_STAGE);
}
