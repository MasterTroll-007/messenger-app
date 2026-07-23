'use strict';

const DEFAULT_MAX_ACTIVE = 32;

function threadKey(message) {
  return `${message.encrypted ? 'e2ee' : 'standard'}:${message.threadId}`;
}

function createMessageNotificationManager({
  NotificationClass,
  isQuitting,
  showWindow,
  navigateToThread,
  logger = console,
  maxActive = DEFAULT_MAX_ACTIVE,
} = {}) {
  const active = new Map();
  const limit = Number.isSafeInteger(maxActive) && maxActive > 0
    ? maxActive
    : DEFAULT_MAX_ACTIVE;

  const detachAndClose = (notification) => {
    try {
      notification.removeAllListeners();
      notification.close();
    } catch {
      // The OS may already have dismissed the toast.
    }
  };

  const release = (key, notification) => {
    if (active.get(key) !== notification) return;
    active.delete(key);
    notification.removeAllListeners();
  };

  const supported = () => {
    try {
      return typeof NotificationClass === 'function'
        && typeof NotificationClass.isSupported === 'function'
        && NotificationClass.isSupported();
    } catch (error) {
      logger.warn?.('Could not query native notification support:', error.message);
      return false;
    }
  };

  const show = (message) => {
    if (isQuitting?.() === true || !supported()) return false;

    const key = threadKey(message);
    const previous = active.get(key);
    if (previous) {
      active.delete(key);
      detachAndClose(previous);
    }

    let notification;
    try {
      notification = new NotificationClass({
        title: message.title,
        body: message.body,
        silent: true,
        timeoutType: 'default',
      });
    } catch (error) {
      logger.warn?.('Could not create native message notification:', error.message);
      return false;
    }

    active.set(key, notification);
    notification.on('click', () => {
      release(key, notification);
      try {
        const win = showWindow?.();
        if (win) navigateToThread?.(win, message);
      } catch (error) {
        logger.warn?.('Could not open a message notification:', error.message);
      }
    });
    notification.on('failed', (_event, error) => {
      release(key, notification);
      logger.warn?.('Native message notification failed:', String(error || 'unknown error'));
    });
    notification.on('close', (details) => {
      // Windows can leave a timed-out toast in Action Center. Retain the
      // object so a later click still focuses the right conversation.
      if (details?.reason !== 'timedOut') release(key, notification);
    });

    try {
      notification.show();
    } catch (error) {
      release(key, notification);
      logger.warn?.('Could not show native message notification:', error.message);
      return false;
    }

    while (active.size > limit) {
      const oldestKey = active.keys().next().value;
      const oldest = active.get(oldestKey);
      active.delete(oldestKey);
      detachAndClose(oldest);
    }
    return true;
  };

  const closeAll = () => {
    const notifications = [...active.values()];
    active.clear();
    notifications.forEach(detachAndClose);
  };

  return {
    show,
    activeCount: () => active.size,
    closeAll,
  };
}

module.exports = {
  createMessageNotificationManager,
};
