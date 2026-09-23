'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDeliveryDestination, navigateDestination } = require('../../bounty-destinations');

test('parses a known cave delivery without changing its destination contract', () => {
  const destination = parseDeliveryDestination('[送货] - 吉芬地下★');

  assert.deepEqual(
    { map: destination.map, x: destination.x, y: destination.y, cave: destination.cave, kind: destination.kind },
    { map: 'gef_dun00', x: 48, y: 165, cave: true, kind: '送信' },
  );
  assert.equal(destination.npcRe.test('喵喵'), true);
});

test('地下水道1层送货 separates the safe flight landing from 喵喵 coordinates', () => {
  const destination = parseDeliveryDestination('[送货] - 地下水道1层★');

  assert.deepEqual(
    {
      map: destination.map,
      npc: [destination.x, destination.y],
      landing: [destination.flyX, destination.flyY],
      alternatives: destination.alt,
      cave: destination.cave,
    },
    {
      map: 'prt_sewb1',
      npc: [192, 253],
      landing: [194, 254],
      alternatives: undefined,
      cave: true,
    },
  );
});

test('地下水道1层 matcher does not swallow other sewer maps or floors', () => {
  assert.equal(parseDeliveryDestination('[送货] - 地下水道2层★'), null);
  assert.equal(parseDeliveryDestination('[送货] - 古城地下水道1层★'), null);
});

test('地下水道1层 navigation flies to the safe landing and keeps 喵喵 as the target', async () => {
  const destination = parseDeliveryDestination('[送货] - 地下水道1层★');
  const calls = [];

  const result = await navigateDestination(destination, {
    gotoMap: async (...args) => { calls.push(args); return true; },
    isOnMap: () => false,
  });

  assert.deepEqual(calls, [['prt_sewb1', 194, 254, true]]);
  assert.deepEqual(result, { ok: true, map: 'prt_sewb1', targetX: 192, targetY: 253 });
  assert.equal(calls.some(([map]) => map === 'gl_sew01'), false);
});
