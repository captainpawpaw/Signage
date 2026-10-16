import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleMatches, resolvePlaylistId, localParts } from '../server/schedule.js';

// 2026-10-14 is a Wednesday (weekday 3).
const at = (date, minutes, weekday) => ({ date, minutes, weekday });

test('localParts honours the time zone', () => {
  const d = new Date('2026-10-14T23:30:00Z');
  assert.deepEqual(localParts(d, 'UTC'), { date: '2026-10-14', minutes: 23 * 60 + 30, weekday: 3 });
  assert.deepEqual(localParts(d, 'Europe/London'), { date: '2026-10-15', minutes: 30, weekday: 4 });
});

test('daytime rule matches only inside its window and days', () => {
  const rule = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' };
  assert.equal(ruleMatches(rule, at('2026-10-14', 8 * 60, 3)), true);
  assert.equal(ruleMatches(rule, at('2026-10-14', 17 * 60, 3)), false);
  assert.equal(ruleMatches(rule, at('2026-10-18', 12 * 60, 0)), false); // Sunday
});

test('overnight rule belongs to the day it starts', () => {
  const rule = { days: [5], start: '22:00', end: '06:00' }; // Friday night
  assert.equal(ruleMatches(rule, at('2026-10-16', 23 * 60, 5)), true);
  assert.equal(ruleMatches(rule, at('2026-10-17', 3 * 60, 6)), true); // Saturday early morning
  assert.equal(ruleMatches(rule, at('2026-10-16', 3 * 60, 5)), false); // Friday early morning = Thursday's night
  assert.equal(ruleMatches(rule, at('2026-10-17', 12 * 60, 6)), false);
});

test('date range and all-day rules', () => {
  const rule = { start: '00:00', end: '00:00', startDate: '2026-12-24', endDate: '2026-12-26' };
  assert.equal(ruleMatches(rule, at('2026-12-25', 600, 5)), true);
  assert.equal(ruleMatches(rule, at('2026-12-27', 600, 0)), false);
});

test('highest priority wins, falls back to default playlist', () => {
  const screen = {
    timezone: 'UTC', defaultPlaylistId: 'default',
    schedule: [
      { id: 'a', playlistId: 'work', start: '08:00', end: '18:00', priority: 0 },
      { id: 'b', playlistId: 'lunch', start: '12:00', end: '13:00', priority: 5 },
      { id: 'c', playlistId: 'off', start: '12:00', end: '13:00', priority: 9, enabled: false },
    ],
  };
  assert.equal(resolvePlaylistId(screen, new Date('2026-10-14T09:00:00Z')), 'work');
  assert.equal(resolvePlaylistId(screen, new Date('2026-10-14T12:30:00Z')), 'lunch');
  assert.equal(resolvePlaylistId(screen, new Date('2026-10-14T20:00:00Z')), 'default');
});
