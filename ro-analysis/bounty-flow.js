'use strict';

function createTurnInTracker() {
  let turnedIn = 0;
  let counted = false;
  return {
    onSay(say) {
      if (!counted && /任务完成.*押金和报酬/.test(say || '')) {
        counted = true;
        turnedIn++;
      }
    },
    onMenu(say, hasSubmit) {
      if (!counted && hasSubmit && /当前任务已完成|任务已完成/.test(say || '')) {
        counted = true;
        turnedIn++;
      }
    },
    count: () => turnedIn,
    inconclusive: (timedOut) => !!timedOut && !counted,
  };
}

function createInitialBountyCheck() {
  let checked = false;
  let count = null;
  return {
    observe(value) {
      if (!checked && count == null && Number.isInteger(value) && value >= 0) count = value;
    },
    shouldCloseMenu: () => !checked && count > 0,
    finishDialogue(inconclusive) {
      if (checked || inconclusive) return null;
      checked = true;
      return { skip: count > 0, count, tasksToRecord: count > 0 ? 0 : null };
    },
  };
}

module.exports = { createTurnInTracker, createInitialBountyCheck };
