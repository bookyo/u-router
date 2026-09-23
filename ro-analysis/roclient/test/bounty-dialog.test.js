'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnInTracker, createInitialBountyCheck } = require('../../bounty-flow');

test('NPC completion speech counts delivery even if the dialog closes without a menu', () => {
  const tracker = createTurnInTracker();
  tracker.onSay('任务完成，这是你的押金和报酬。');
  assert.equal(tracker.count(), 1);
  assert.equal(tracker.inconclusive(true), false);
});

test('completion speech followed by a submit menu counts once', () => {
  const tracker = createTurnInTracker();
  tracker.onSay('任务完成，这是你的押金和报酬。');
  tracker.onMenu('任务完成，这是你的押金和报酬。', true);
  assert.equal(tracker.count(), 1);
});

test('completed-task menu counts delivery only when a submit option exists', () => {
  const tracker = createTurnInTracker();
  tracker.onMenu('当前任务已完成。', false);
  assert.equal(tracker.count(), 0);
  tracker.onMenu('当前任务已完成。', true);
  assert.equal(tracker.count(), 1);
});

test('first NPC report of four completed tasks closes the menu and skips this account', () => {
  const check = createInitialBountyCheck();
  check.observe(4);
  assert.equal(check.shouldCloseMenu(), true);
  assert.deepEqual(check.finishDialogue(false), { skip: true, count: 4, tasksToRecord: 0 });
});

test('first NPC report of zero does not skip later progress of one to four tasks', () => {
  const check = createInitialBountyCheck();
  check.observe(0);
  assert.equal(check.shouldCloseMenu(), false);
  assert.deepEqual(check.finishDialogue(false), { skip: false, count: 0, tasksToRecord: null });
  check.observe(4);
  assert.equal(check.shouldCloseMenu(), false);
  assert.equal(check.finishDialogue(false), null);
});

test('a timed out first conversation does not consume the initial NPC check', () => {
  const check = createInitialBountyCheck();
  assert.equal(check.finishDialogue(true), null);
  check.observe(4);
  assert.deepEqual(check.finishDialogue(false), { skip: true, count: 4, tasksToRecord: 0 });
});
