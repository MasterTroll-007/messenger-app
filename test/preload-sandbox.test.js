'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPreloadInSandbox() {
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  const source = fs.readFileSync(preloadPath, 'utf8');
  const requiredModules = [];
  const ipcListeners = new Map();
  const windowListeners = new Map();

  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.currentTime = 0;
      this.preload = '';
    }

    play() {
      return Promise.resolve();
    }

    pause() {}

    removeAttribute(name) {
      if (name === 'src') this.src = undefined;
    }

    load() {}
  }

  const electron = {
    ipcRenderer: {
      on(channel, listener) {
        ipcListeners.set(channel, listener);
      },
      send() {},
    },
  };

  const context = {
    Audio: FakeAudio,
    __dirname: path.dirname(preloadPath),
    __filename: preloadPath,
    clearTimeout() {},
    console,
    exports: {},
    globalThis: null,
    module: { exports: {} },
    performance: { now: () => 0 },
    queueMicrotask(callback) {
      callback();
    },
    require(specifier) {
      requiredModules.push(specifier);
      if (specifier !== 'electron') {
        throw new Error(`unexpected preload import: ${specifier}`);
      }
      return electron;
    },
    setTimeout() {
      return 0;
    },
    window: {
      addEventListener(type, listener) {
        windowListeners.set(type, listener);
      },
    },
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: preloadPath });

  return { ipcListeners, requiredModules, windowListeners };
}

test('sandboxed preload boots and handles startup events with Electron-only imports', () => {
  const { ipcListeners, requiredModules, windowListeners } = loadPreloadInSandbox();

  assert.deepEqual(requiredModules, ['electron']);
  assert.equal(typeof windowListeners.get('DOMContentLoaded'), 'function');

  ipcListeners.get('play-notification-sound')();
  ipcListeners.get('stop-notification-sound')();
  ipcListeners.get('notification-sound-updated')();
  ipcListeners.get('unread-route-policy')(null, { clear: false, content: true, retireRetained: true });
  ipcListeners.get('title-unread-hint')(null, { available: true, count: 3 });

  assert.deepEqual(requiredModules, ['electron']);
});
