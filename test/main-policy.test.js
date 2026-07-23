'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const packageJson = require('../package.json');

const {
  APP_USER_MODEL_ID,
  classifyNavigationUrl,
  createUsableBadgeImage,
  getTitleUnreadHint,
  isAllowedAppUrl,
  isAllowedContentUrl,
  isAllowedPermissionRequest,
  isExpectedNavigationAbort,
  isOwnedTemporaryFileName,
  isSafeExternalUrl,
  normalizeRequestedMediaTypes,
  parseUnreadCountFromTitle,
  permitUnloadForApplicationQuit,
  shouldHandleUpdateAvailable,
  soundHeaderMatchesExtension,
  TOAST_ACTIVATOR_CLSID,
  validateMessageNotificationPayload,
  validateUnreadStatePayload,
} = require('../lib/main-policy');

function pngDataUrl(width = 16, height = 16) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('title parser accepts only an anchored, bounded unread prefix', () => {
  assert.equal(parseUnreadCountFromTitle('(12) Messenger'), 12);
  assert.equal(parseUnreadCountFromTitle('  (0) Messenger'), 0);
  assert.equal(parseUnreadCountFromTitle('Chat with (12) Alice'), null);
  assert.equal(parseUnreadCountFromTitle('(10000) Messenger'), null);
  assert.equal(parseUnreadCountFromTitle('(2)Messenger'), null);
  assert.deepEqual(getTitleUnreadHint('Alice'), { available: false, count: 0 });
  assert.deepEqual(getTitleUnreadHint('(3) Messenger'), { available: true, count: 3 });
});

test('app URLs require HTTPS, an exact host, and an approved route', () => {
  assert.equal(isAllowedAppUrl('https://www.facebook.com/messages/t/123'), true);
  assert.equal(isAllowedAppUrl('https://www.facebook.com/messenger_media/?attachment_id=123'), true);
  assert.equal(isAllowedAppUrl('https://www.facebook.com/photo/?fbid=123'), true);
  assert.equal(isAllowedAppUrl('https://www.facebook.com/photo.php?fbid=123'), true);
  assert.equal(isAllowedAppUrl('https://facebook.com/login.php?next=%2Fmessages'), true);
  assert.equal(isAllowedAppUrl('https://www.messenger.com/t/123'), true);
  assert.equal(isAllowedAppUrl('https://www.facebook.com/profile.php?id=1'), false);
  assert.equal(isAllowedAppUrl('https://evil.facebook.com/messages/'), false);
  assert.equal(isAllowedAppUrl('http://www.facebook.com/messages/'), false);
  assert.equal(isAllowedAppUrl('https://www.facebook.com:444/messages/'), false);
  assert.equal(isAllowedAppUrl('javascript:alert(1)'), false);
});

test('external URL policy allows only safe schemes and never reclassifies app URLs', () => {
  assert.equal(isSafeExternalUrl('https://example.com/path'), true);
  assert.equal(isSafeExternalUrl('mailto:test@example.com'), true);
  assert.equal(isSafeExternalUrl('http://example.com'), false);
  assert.equal(isSafeExternalUrl('file:///C:/secret.txt'), false);
  assert.equal(classifyNavigationUrl('https://www.facebook.com/messages/'), 'internal');
  assert.equal(
    classifyNavigationUrl('https://www.facebook.com/messenger_media/?attachment_id=123'),
    'internal',
  );
  assert.equal(classifyNavigationUrl('https://www.facebook.com/photo/?fbid=123'), 'internal');
  assert.equal(classifyNavigationUrl('https://www.facebook.com/photo.php?fbid=123'), 'internal');
  assert.equal(classifyNavigationUrl('https://www.facebook.com/marketplace/'), 'external');
  assert.equal(classifyNavigationUrl('https://example.com/'), 'external');
  assert.equal(classifyNavigationUrl('data:text/html,hello'), 'blocked');
});

test('permission policy is main-frame, route, and permission specific', () => {
  const base = {
    requestingUrl: 'https://www.facebook.com/messages/',
    isMainFrame: true,
  };

  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'notifications' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'clipboard-sanitized-write' }), true);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'clipboard-read' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'mediaKeySystem' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media' }), true);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: ['audio'] }), true);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: ['video'] }), true);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: ['audio', 'video'] }), true);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: [] }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: ['display'] }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'geolocation' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'notifications', isMainFrame: false }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'notifications', requestingUrl: 'https://www.facebook.com/profile.php' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'notifications', requestingUrl: 'https://www.facebook.com/login.php' }), false);
  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'media', mediaTypes: ['audio'], requestingUrl: 'https://www.facebook.com/checkpoint/' }), false);
  assert.equal(isAllowedContentUrl('https://www.facebook.com/messages/t/123'), true);
  assert.equal(isAllowedContentUrl('https://www.messenger.com/t/123'), true);
  assert.equal(isAllowedContentUrl('https://www.messenger.com/'), true);
  assert.equal(isAllowedContentUrl('https://www.messenger.com/login/'), false);
});

test('Windows notification identity stays aligned with the NSIS app id', () => {
  assert.equal(APP_USER_MODEL_ID, packageJson.build.appId);
  assert.match(TOAST_ACTIVATOR_CLSID, /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/);
});

test('media type normalization permits only Electron preliminary or audio/video checks', () => {
  assert.equal(normalizeRequestedMediaTypes({}), undefined);
  assert.equal(normalizeRequestedMediaTypes({ mediaType: 'unknown' }), undefined);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaType: 'audio' }), ['audio']);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaType: 'video' }), ['video']);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaTypes: ['audio', 'video'] }), ['audio', 'video']);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaTypes: [] }), []);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaType: 'display' }), []);
  assert.deepEqual(normalizeRequestedMediaTypes({ mediaTypes: ['future-capture'] }), ['future-capture']);
});

test('duplicate update availability never overwrites an active or completed download phase', () => {
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'idle' }), true);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'checking' }), true);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'available' }), true);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'available', updatePromptOpen: true }), false);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'downloading' }), false);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'downloaded' }), false);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'error' }), false);
  assert.equal(shouldHandleUpdateAvailable({}), false);
  assert.equal(shouldHandleUpdateAvailable({ updatePhase: 'checking', isQuitting: true }), false);
});

test('startup cleanup recognizes only this app own atomic temporary files', () => {
  const first = '123e4567-e89b-42d3-a456-426614174000';
  const second = '223e4567-e89b-42d3-b456-426614174001';
  assert.equal(isOwnedTemporaryFileName(`settings.json.${first}.tmp`), true);
  assert.equal(isOwnedTemporaryFileName(`.notification-custom-${first}.mp3.${second}.tmp`), true);
  assert.equal(isOwnedTemporaryFileName(`.notification-custom-${first}.M4A.${second}.tmp`), true);
  assert.equal(isOwnedTemporaryFileName('settings.json.tmp'), false);
  assert.equal(isOwnedTemporaryFileName(`notification-custom-${first}.mp3.${second}.tmp`), false);
  assert.equal(isOwnedTemporaryFileName(`.notification-custom-${first}.exe.${second}.tmp`), false);
  assert.equal(isOwnedTemporaryFileName(`nested/settings.json.${first}.tmp`), false);
  assert.equal(isOwnedTemporaryFileName('.unrelated.tmp'), false);
});

test('only an explicit Chromium navigation abort can satisfy an interrupted load', () => {
  assert.equal(isExpectedNavigationAbort({ code: 'ERR_ABORTED' }), true);
  assert.equal(isExpectedNavigationAbort({ code: -3 }), true);
  assert.equal(isExpectedNavigationAbort({ errno: -3 }), true);
  assert.equal(isExpectedNavigationAbort({ code: 'ERR_NAME_NOT_RESOLVED' }), false);
  assert.equal(isExpectedNavigationAbort({ code: -105 }), false);
  assert.equal(isExpectedNavigationAbort(new Error('ERR_ABORTED')), false);
});

test('beforeunload is bypassed only while the application is explicitly quitting', () => {
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };

  assert.equal(permitUnloadForApplicationQuit(event, false), false);
  assert.equal(prevented, 0);
  assert.equal(permitUnloadForApplicationQuit(event, true), true);
  assert.equal(prevented, 1);
  assert.equal(permitUnloadForApplicationQuit(null, true), false);
});

test('notification sound signatures must match their declared container', () => {
  assert.equal(soundHeaderMatchesExtension(Buffer.from('ID3\u0004'), '.mp3'), true);
  assert.equal(soundHeaderMatchesExtension(Buffer.from([0xff, 0xfb, 0x90, 0x00]), '.MP3'), true);
  assert.equal(soundHeaderMatchesExtension(Buffer.from('OggSdata'), '.ogg'), true);
  assert.equal(soundHeaderMatchesExtension(Buffer.from('RIFF0000WAVE'), '.wav'), true);
  assert.equal(soundHeaderMatchesExtension(Buffer.from('0000ftypM4A '), '.m4a'), true);
  assert.equal(soundHeaderMatchesExtension(Buffer.from('0000ftypM4A '), '.mp3'), false);
  assert.equal(soundHeaderMatchesExtension(Buffer.from('not audio'), '.wav'), false);
});

test('unread IPC payload validation bounds count and PNG dimensions/size', () => {
  const badgeDataUrl = pngDataUrl();
  assert.deepEqual(
    validateUnreadStatePayload({ count: 4, notify: true, badgeDataUrl }),
    { count: 4, notify: false, badgeDataUrl, message: null },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 0, notify: true, badgeDataUrl }),
    { count: 0, notify: false, badgeDataUrl: null, message: null },
  );
  assert.equal(validateUnreadStatePayload({ count: -1, notify: false, badgeDataUrl: null }), null);
  assert.equal(validateUnreadStatePayload({ count: 10000, notify: false, badgeDataUrl: null }), null);
  assert.equal(validateUnreadStatePayload({ count: 1, notify: 1, badgeDataUrl: null }), null);
  assert.deepEqual(
    validateUnreadStatePayload({ count: 1, notify: true, badgeDataUrl: 'data:image/png;base64,bm90LXBuZw==' }),
    { count: 1, notify: false, badgeDataUrl: null, message: null },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 1, notify: false, badgeDataUrl: pngDataUrl(65, 16) }),
    { count: 1, notify: false, badgeDataUrl: null, message: null },
  );
});

test('message notification metadata is bounded, sanitized, and independent from badge state', () => {
  const message = {
    threadId: ' 7566987333382615 ',
    encrypted: true,
    title: '  Příliš\nživý   název  ',
    body: '  Ahoj\u0000   světe!  ',
  };
  const expected = {
    threadId: '7566987333382615',
    encrypted: true,
    title: 'Příliš živý název',
    body: 'Ahoj světe!',
  };
  assert.deepEqual(validateMessageNotificationPayload(message), expected);
  assert.deepEqual(
    validateMessageNotificationPayload({
      ...message,
      title: `Alice\u202e${'x'.repeat(130)}`,
      body: 'Ahoj\u2066 světe\u2069',
    }),
    {
      ...expected,
      title: `Alice ${'x'.repeat(114)}`,
      body: 'Ahoj světe',
    },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 2, notify: true, badgeDataUrl: null, message }),
    { count: 2, notify: true, badgeDataUrl: null, message: expected },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 2, notify: false, badgeDataUrl: null, message }),
    { count: 2, notify: false, badgeDataUrl: null, message: null },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 0, notify: true, badgeDataUrl: null, message }),
    { count: 0, notify: true, badgeDataUrl: null, message: expected },
  );
  assert.equal(validateMessageNotificationPayload({ ...message, threadId: '../marketplace' }), null);
  assert.equal(validateMessageNotificationPayload({
    ...message,
    threadId: 'x'.repeat(257),
  }), null);
  assert.equal(validateMessageNotificationPayload({ ...message, encrypted: 'true' }), null);
  assert.equal(validateMessageNotificationPayload({ ...message, body: '   ' }), null);
  assert.deepEqual(
    validateUnreadStatePayload({ count: 3, notify: true, badgeDataUrl: null, message: { nope: true } }),
    { count: 3, notify: false, badgeDataUrl: null, message: null },
  );
});

test('native badge decoding degrades independently from unread state', () => {
  const validImage = {
    getSize: () => ({ width: 48, height: 48 }),
    isEmpty: () => false,
  };
  assert.equal(createUsableBadgeImage('badge', () => validImage), validImage);
  assert.equal(createUsableBadgeImage('badge', () => { throw new Error('decode failed'); }), null);
  assert.equal(createUsableBadgeImage('badge', () => ({
    getSize: () => ({ width: 65, height: 48 }),
    isEmpty: () => false,
  })), null);
  assert.equal(createUsableBadgeImage('badge', () => ({
    getSize: () => ({ width: 48, height: 48 }),
    isEmpty: () => true,
  })), null);
});
