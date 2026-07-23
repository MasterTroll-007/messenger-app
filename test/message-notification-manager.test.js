'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createMessageNotificationManager } = require('../lib/message-notification-manager');

class FakeNotification extends EventEmitter {
  static instances = [];
  static supported = true;

  static isSupported() {
    return FakeNotification.supported;
  }

  constructor(options) {
    super();
    this.options = options;
    this.shown = 0;
    this.closed = 0;
    FakeNotification.instances.push(this);
  }

  show() {
    this.shown += 1;
  }

  close() {
    this.closed += 1;
  }
}

const message = (threadId = '123') => ({
  threadId,
  encrypted: true,
  title: 'Alice',
  body: 'Ahoj!',
});

test.beforeEach(() => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
});

test('message manager shows one silent native toast and opens its thread on click', () => {
  const window = { id: 'window' };
  const opened = [];
  let focusCount = 0;
  const manager = createMessageNotificationManager({
    NotificationClass: FakeNotification,
    isQuitting: () => false,
    showWindow: () => {
      focusCount += 1;
      return window;
    },
    navigateToThread: (win, details) => opened.push({ win, details }),
  });

  assert.equal(manager.show(message()), true);
  assert.equal(manager.activeCount(), 1);
  assert.equal(FakeNotification.instances.length, 1);
  assert.deepEqual(FakeNotification.instances[0].options, {
    title: 'Alice',
    body: 'Ahoj!',
    silent: true,
    timeoutType: 'default',
  });
  assert.equal(FakeNotification.instances[0].shown, 1);

  FakeNotification.instances[0].emit('click', {});
  assert.equal(focusCount, 1);
  assert.deepEqual(opened, [{ win: window, details: message() }]);
  assert.equal(manager.activeCount(), 0);
});

test('message manager suppresses unsupported/quitting notifications and cleans failed ones', () => {
  const warnings = [];
  const manager = createMessageNotificationManager({
    NotificationClass: FakeNotification,
    isQuitting: () => false,
    logger: { warn: (...args) => warnings.push(args) },
  });

  FakeNotification.supported = false;
  assert.equal(manager.show(message()), false);
  assert.equal(FakeNotification.instances.length, 0);

  FakeNotification.supported = true;
  assert.equal(manager.show(message()), true);
  FakeNotification.instances[0].emit('failed', {}, 'toast failure');
  assert.equal(manager.activeCount(), 0);
  assert.match(warnings[0].join(' '), /toast failure/);

  const quittingManager = createMessageNotificationManager({
    NotificationClass: FakeNotification,
    isQuitting: () => true,
  });
  assert.equal(quittingManager.show(message('quit')), false);
});

test('message manager contains native support, constructor, and show failures', () => {
  const warnings = [];
  class SupportFailure {
    static isSupported() {
      throw new Error('support probe failed');
    }
  }
  const unsupported = createMessageNotificationManager({
    NotificationClass: SupportFailure,
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(unsupported.show(message()), false);

  class ConstructorFailure {
    static isSupported() {
      return true;
    }

    constructor() {
      throw new Error('constructor failed');
    }
  }
  const constructorFailure = createMessageNotificationManager({
    NotificationClass: ConstructorFailure,
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(constructorFailure.show(message()), false);
  assert.equal(constructorFailure.activeCount(), 0);

  class ShowFailure extends FakeNotification {
    show() {
      throw new Error('show failed');
    }
  }
  const showFailure = createMessageNotificationManager({
    NotificationClass: ShowFailure,
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(showFailure.show(message()), false);
  assert.equal(showFailure.activeCount(), 0);
  assert.match(warnings.flat().join(' '), /support probe failed/);
  assert.match(warnings.flat().join(' '), /constructor failed/);
  assert.match(warnings.flat().join(' '), /show failed/);
});

test('message manager replaces per-thread toasts and bounds retained Action Center handlers', () => {
  const manager = createMessageNotificationManager({
    NotificationClass: FakeNotification,
    isQuitting: () => false,
    maxActive: 2,
  });

  assert.equal(manager.show(message('a')), true);
  const first = FakeNotification.instances[0];
  assert.equal(manager.show({ ...message('a'), body: 'Druhá zpráva' }), true);
  assert.equal(first.closed, 1);
  assert.equal(manager.activeCount(), 1);

  assert.equal(manager.show(message('b')), true);
  assert.equal(manager.show(message('c')), true);
  assert.equal(manager.activeCount(), 2);
  assert.equal(FakeNotification.instances[1].closed, 1);

  const latest = FakeNotification.instances.at(-1);
  latest.emit('close', { reason: 'timedOut' });
  assert.equal(manager.activeCount(), 2);
  latest.emit('close', { reason: 'userCanceled' });
  assert.equal(manager.activeCount(), 1);
  manager.closeAll();
  assert.equal(manager.activeCount(), 0);
  assert.equal(FakeNotification.instances[2].closed, 1);
});
