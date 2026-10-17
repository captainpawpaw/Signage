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

export function screenGroups(screen, groups = []) {
  return (screen.groupIds || []).map((id) => groups.find((g) => g.id === id)).filter(Boolean);
}

export function effectiveRules(screen, groups = []) {
  const own = (screen.schedule || []).map((r) => ({ ...r, group: null }));
  const inherited = screenGroups(screen, groups).flatMap((g) => (g.schedule || []).map((r) => ({ ...r, group: { id: g.id, name: g.name } })));
  return own.concat(inherited);
}

export function activeRule(screen, now = new Date(), groups = []) {
  const parts = localParts(now, screen.timezone || DEFAULT_TIMEZONE);
  let best = null;
  for (const rule of effectiveRules(screen, groups)) {
    if (rule.enabled === false || !ruleMatches(rule, parts)) continue;
    if (!best || (rule.priority || 0) > (best.priority || 0)) best = rule;
  }
  return best;
}

export function resolvePlaylistId(screen, now = new Date(), groups = []) {
  const rule = activeRule(screen, now, groups);
  if (rule) return rule.playlistId;
  return screen.defaultPlaylistId || screenGroups(screen, groups).find((g) => g.defaultPlaylistId)?.defaultPlaylistId || null;
}
