'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyNavigationUrl,
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
  assert.equal(classifyNavigationUrl('https://www.facebook.com/marketplace/'), 'external');
  assert.equal(classifyNavigationUrl('https://example.com/'), 'external');
  assert.equal(classifyNavigationUrl('data:text/html,hello'), 'blocked');
});

test('permission policy is main-frame, route, and permission specific', () => {
  const base = {
    requestingUrl: 'https://www.facebook.com/messages/',
    isMainFrame: true,
  };

  assert.equal(isAllowedPermissionRequest({ ...base, permission: 'notifications' }), true);
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
    { count: 4, notify: true, badgeDataUrl },
  );
  assert.deepEqual(
    validateUnreadStatePayload({ count: 0, notify: true, badgeDataUrl }),
    { count: 0, notify: false, badgeDataUrl: null },
  );
  assert.equal(validateUnreadStatePayload({ count: -1, notify: false, badgeDataUrl: null }), null);
  assert.equal(validateUnreadStatePayload({ count: 10000, notify: false, badgeDataUrl: null }), null);
  assert.equal(validateUnreadStatePayload({ count: 1, notify: 1, badgeDataUrl: null }), null);
  assert.equal(validateUnreadStatePayload({ count: 1, notify: false, badgeDataUrl: 'data:image/png;base64,bm90LXBuZw==' }), null);
  assert.equal(validateUnreadStatePayload({ count: 1, notify: false, badgeDataUrl: pngDataUrl(65, 16) }), null);
});
