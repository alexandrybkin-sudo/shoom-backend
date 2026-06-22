import { test } from 'node:test';
import assert from 'node:assert';
import { computeVerdict, tallyVotes, sideKey, Side } from './voting';

test('last window is weighted x2 (climax decides)', () => {
  // window0: A leads 10-0; last window: B leads 0-10 -> weighted A=10, B=20
  const v = computeVerdict([{ a: 10, b: 0 }, { a: 0, b: 10 }]);
  assert.equal(v.winnerSide, 'B');
  assert.ok(v.finalShareB > v.finalShareA);
});

test('clear majority wins', () => {
  const v = computeVerdict([{ a: 8, b: 2 }, { a: 7, b: 3 }]);
  assert.equal(v.winnerSide, 'A');
});

test('tie within TIE_EPS', () => {
  const v = computeVerdict([{ a: 50, b: 50 }]);
  assert.equal(v.winnerSide, 'tie');
});

test('swing award goes to the side that gained the room', () => {
  // first window A share 0.2, last window A share 0.8 -> swing A 0.6
  const v = computeVerdict([{ a: 2, b: 8 }, { a: 8, b: 2 }]);
  assert.equal(v.swingWinner, 'A');
  assert.ok(v.swingPct >= 0.05);
});

test('no swing below SWING_MIN', () => {
  const v = computeVerdict([{ a: 5, b: 5 }, { a: 5, b: 5 }]);
  assert.equal(v.swingWinner, 'none');
  assert.equal(v.swingPct, 0);
});

test('empty match is a tie with no swing', () => {
  const v = computeVerdict([]);
  assert.equal(v.winnerSide, 'tie');
  assert.equal(v.swingWinner, 'none');
});

test('double vote in same window is last-write-wins', () => {
  const votes = new Map<string, Side>();
  votes.set('u1', 'A');
  votes.set('u1', 'B'); // overwrite
  votes.set('u2', 'A');
  const t = tallyVotes(votes);
  assert.deepEqual(t, { a: 1, b: 1 });
});

test('sideKey normalizes labels', () => {
  assert.equal(sideKey('iPhone 15'), 'iphone-15');
  assert.equal(sideKey('  Android!! '), 'android');
});
