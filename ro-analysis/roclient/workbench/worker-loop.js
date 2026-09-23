'use strict';

function cancelDeferredStart(tab) {
  clearTimeout(tab.loopTimer);
  tab.loopTimer = null;
}

function scheduleDeferredStart(tab, delayMs, shouldStart, start) {
  cancelDeferredStart(tab);
  tab.loopTimer = setTimeout(() => {
    tab.loopTimer = null;
    if (shouldStart()) start();
  }, delayMs);
}

module.exports = { cancelDeferredStart, scheduleDeferredStart };
