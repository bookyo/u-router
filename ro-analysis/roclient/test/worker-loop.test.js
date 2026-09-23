'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleDeferredStart, cancelDeferredStart } = require('../workbench/worker-loop');

test('stopping during a bounty loop delay cancels the next account start', async () => {
  const tab = {};
  let starts = 0;
  scheduleDeferredStart(tab, 10, () => true, () => { starts++; });
  cancelDeferredStart(tab);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(starts, 0);
  assert.equal(tab.loopTimer, null);
});

test('an uncancelled loop delay starts exactly once', async () => {
  const tab = {};
  let starts = 0;
  scheduleDeferredStart(tab, 10, () => true, () => { starts++; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(starts, 1);
  assert.equal(tab.loopTimer, null);
});
