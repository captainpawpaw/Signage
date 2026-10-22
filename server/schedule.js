// Resolves which playlist a screen should be showing right now.
//
// A screen has a default playlist plus an ordered list of schedule rules:
//   { playlistId, days: [0-6] (0 = Sunday, empty = every day),
//     start: 'HH:MM', end: 'HH:MM', startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD',
//     priority: number, enabled: boolean }
// Times are evaluated in the screen's own time zone. end <= start means the
// rule runs overnight (e.g. 22:00-06:00), and start == end means all day.
// The matching rule with the highest priority wins; ties go to the earliest rule.
// Screens also inherit the rules of every group they belong to; their own rules
// come first, so they win ties against group rules.

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date, timeZone = DEFAULT_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
  };
}

function toMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function previousDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function ruleMatches(rule, parts) {
  const days = rule.days?.length ? rule.days : [0, 1, 2, 3, 4, 5, 6];
  const start = toMinutes(rule.start, 0);
  const end = toMinutes(rule.end, 24 * 60);
  const inRange = (d) => (!rule.startDate || d >= rule.startDate) && (!rule.endDate || d <= rule.endDate);
  const onDay = (weekday, d) => days.includes(weekday) && inRange(d);

  if (start === end) return onDay(parts.weekday, parts.date);
  if (start < end) return parts.minutes >= start && parts.minutes < end && onDay(parts.weekday, parts.date);
  // Overnight: the evening part belongs to today, the early-morning part to yesterday's rule.
  if (parts.minutes >= start) return onDay(parts.weekday, parts.date);
  if (parts.minutes < end) return onDay((parts.weekday + 6) % 7, previousDate(parts.date));
  return false;
}

// `ctx` is either the list of groups (older callers, tests) or anything with
// { groups, schedules }, e.g. the store.
function context(ctx) {
  if (Array.isArray(ctx)) return { groups: ctx, schedules: [] };
  return { groups: ctx?.groups || [], schedules: ctx?.schedules || [] };
}

export function screenGroups(screen, ctx = []) {
  const { groups } = context(ctx);
  return (screen.groupIds || []).map((id) => groups.find((g) => g.id === id)).filter(Boolean);
}

// Every rule that applies to a screen, in tie-break order: the screen's own
// rules, schedule entries aimed at the screen, entries aimed at its groups,
// then rules stored on its groups.
export function effectiveRules(screen, ctx = []) {
  const { schedules } = context(ctx);
  const memberGroups = screenGroups(screen, ctx);
  const groupIds = new Set(memberGroups.map((g) => g.id));
  const groupRef = (g) => (g ? { id: g.id, name: g.name } : null);
  const own = (screen.schedule || []).map((r) => ({ ...r, group: null }));
  const direct = schedules.filter((e) => e.targets?.screenIds?.includes(screen.id)).map((e) => ({ ...e, group: null }));
  const viaGroup = schedules
    .filter((e) => !e.targets?.screenIds?.includes(screen.id) && e.targets?.groupIds?.some((g) => groupIds.has(g)))
    .map((e) => ({ ...e, group: groupRef(memberGroups.find((g) => e.targets.groupIds.includes(g.id))) }));
  const inherited = memberGroups.flatMap((g) => (g.schedule || []).map((r) => ({ ...r, group: groupRef(g) })));
  return [...own, ...direct, ...viaGroup, ...inherited];
}

// "Play now": content an admin put on a screen by hand, until a set time or
// until stopped. It beats every schedule rule while it lasts.
//   screen.override = { playlistId, from: epoch ms, until: epoch ms | null }
export const OVERRIDE_RULE_ID = 'play-now';

export function activeOverride(screen, t = Date.now()) {
  const o = screen.override;
  return o?.playlistId && t >= (o.from || 0) && (!o.until || t < o.until) ? o : null;
}

export function activeRule(screen, now = new Date(), ctx = []) {
  const o = activeOverride(screen, now.getTime());
  if (o) return { id: OVERRIDE_RULE_ID, name: 'Play now', playlistId: o.playlistId, until: o.until || null, priority: Infinity, group: null };
  const parts = localParts(now, screen.timezone || DEFAULT_TIMEZONE);
  let best = null;
  for (const rule of effectiveRules(screen, ctx)) {
    if (rule.enabled === false || !ruleMatches(rule, parts)) continue;
    if (!best || (rule.priority || 0) > (best.priority || 0)) best = rule;
  }
  return best;
}

export function defaultPlaylistId(screen, ctx = []) {
  return screen.defaultPlaylistId || screenGroups(screen, ctx).find((g) => g.defaultPlaylistId)?.defaultPlaylistId || null;
}

export function resolvePlaylistId(screen, now = new Date(), ctx = []) {
  const rule = activeRule(screen, now, ctx);
  return rule ? rule.playlistId : defaultPlaylistId(screen, ctx);
}

// ---------- timetable for offline switching ----------
// Screens get the playlist changes for the coming days so they can switch at
// the right moment even when they can't reach the server. Segments are
// [{ from: epoch ms, playlistId }], each running until the next one starts.

export const TIMELINE_DAYS = 8;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map();

// Offset of the time zone from UTC at instant t, in ms (handles DST).
function zoneOffset(t, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  }
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(t / MINUTE) * MINUTE;
}

const dateStrings = new Map();
function partsFromLocal(localMs) {
  const dayNumber = Math.floor(localMs / DAY);
  if (!dateStrings.has(dayNumber)) {
    if (dateStrings.size > 5000) dateStrings.clear();
    dateStrings.set(dayNumber, new Date(dayNumber * DAY).toISOString().slice(0, 10));
  }
  return {
    date: dateStrings.get(dayNumber),
    minutes: Math.floor((localMs - dayNumber * DAY) / MINUTE),
    weekday: (dayNumber + 4) % 7, // 1 Jan 1970 was a Thursday
  };
}

const timelineCache = new Map();

// Minute-by-minute evaluation over the window, using a zone offset refreshed
// every 15 minutes (DST changes happen on those boundaries). Cached per day.
export function scheduleTimeline(screen, ctx = [], now = Date.now(), days = TIMELINE_DAYS) {
  return withOverride(baseTimeline(screen, ctx, now, days), screen.override);
}

function withOverride(result, o) {
  if (!o?.playlistId) return result;
  const from = Math.max(o.from || 0, result.start);
  const until = o.until ? Math.min(o.until, result.end) : result.end;
  if (until <= from) return result;
  const segments = result.segments.filter((seg) => seg.from < from);
  segments.push({ from, playlistId: o.playlistId, ruleId: OVERRIDE_RULE_ID });
  if (until < result.end) {
    const resume = [...result.segments].reverse().find((seg) => seg.from <= until);
    segments.push({ from: until, playlistId: resume.playlistId, ruleId: resume.ruleId });
    segments.push(...result.segments.filter((seg) => seg.from > until));
  }
  return { ...result, segments };
}

function baseTimeline(screen, ctx, now, days) {
  const timeZone = screen.timezone || DEFAULT_TIMEZONE;
  const rules = effectiveRules(screen, ctx).filter((r) => r.enabled !== false);
  const fallback = defaultPlaylistId(screen, ctx);
  const start = Math.floor(now / DAY) * DAY; // UTC midnight: stable for a whole day
  const end = start + days * DAY;
  const key = JSON.stringify([timeZone, rules, fallback, start, days]);
  if (timelineCache.has(key)) return timelineCache.get(key);

  // The answer can only change at a rule's start/end minute, at local midnight
  // (date ranges and weekdays) or when the clocks change, so only look then.
  const boundaries = new Set([0]);
  for (const r of rules) { boundaries.add(toMinutes(r.start, 0)); boundaries.add(toMinutes(r.end, 24 * 60) % (24 * 60)); }
  const segments = [];
  let offset = null;
  for (let t = start; t < end; t += MINUTE) {
    let offsetChanged = false;
    if ((t - start) % (15 * MINUTE) === 0) {
      const next = zoneOffset(t, timeZone);
      offsetChanged = next !== offset;
      offset = next;
    }
    const localMinute = Math.floor(((t + offset) % DAY + DAY) % DAY / MINUTE);
    if (segments.length && !offsetChanged && !boundaries.has(localMinute)) continue;
    const parts = partsFromLocal(t + offset);
    let best = null;
    for (const rule of rules) {
      if (ruleMatches(rule, parts) && (!best || (rule.priority || 0) > (best.priority || 0))) best = rule;
    }
    const playlistId = best ? best.playlistId : fallback;
    const ruleId = best?.id || null;
    const last = segments[segments.length - 1];
    if (!last || last.playlistId !== playlistId || last.ruleId !== ruleId) segments.push({ from: t, playlistId, ruleId });
  }
  const result = { start, end, segments };
  if (timelineCache.size > 500) timelineCache.clear();
  timelineCache.set(key, result);
  return result;
}

// Which playlist a timetable says should play at time t. Past the end, the
// last week of the timetable repeats (weekly rules keep working).
export function playlistAt(timeline, t) {
  const week = 7 * DAY;
  if (t >= timeline.end) t = timeline.end - week + ((t - (timeline.end - week)) % week);
  let current = timeline.segments[0]?.playlistId ?? null;
  for (const s of timeline.segments) {
    if (s.from > t) break;
    current = s.playlistId;
  }
  return current;
}

// UTC instants of local midnight for `count` days from today (plus the next
// one, so each day has an end), in the given time zone. DST-safe.
export function localMidnights(timeZone, now = Date.now(), count = 7) {
  const off = zoneOffset(now, timeZone);
  const todayLocal = Math.floor((now + off) / DAY) * DAY;
  const out = [];
  for (let i = 0; i <= count; i++) {
    const local = todayLocal + i * DAY;
    let utc = local - off;
    utc = local - zoneOffset(utc, timeZone);
    utc = local - zoneOffset(utc, timeZone);
    out.push(utc);
  }
  return out;
}
