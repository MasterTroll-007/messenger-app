'use strict';

const MAX_UNREAD_COUNT = 9999;
const MAX_BADGE_PNG_BYTES = 64 * 1024;
const UUID_PATTERN_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWNED_TEMP_FILE_PATTERNS = [
  new RegExp(`^settings\\.json\\.${UUID_PATTERN_SOURCE}\\.tmp$`, 'i'),
  new RegExp(`^\\.notification-custom-${UUID_PATTERN_SOURCE}\\.(?:mp3|wav|ogg|m4a)\\.${UUID_PATTERN_SOURCE}\\.tmp$`, 'i'),
];

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
]);

const MESSENGER_HOSTS = new Set([
  'messenger.com',
  'www.messenger.com',
]);

const FACEBOOK_APP_PATHS = [
  /^\/messages(?:\/|$)/,
  /^\/login(?:\.php|\/|$)/,
  /^\/checkpoint(?:\/|$)/,
  /^\/recover(?:\/|$)/,
  /^\/two_step_verification(?:\/|$)/,
  /^\/auth_platform(?:\/|$)/,
  /^\/(?:privacy|cookie)\/consent(?:\/|$)/,
  /^\/dialog\/oauth(?:\/|$)/,
  /^\/oauth(?:\/|$)/,
];

const LEGACY_APP_PATHS = [
  /^\/$/,
  /^\/t(?:\/|$)/,
  /^\/login(?:\/|$)/,
  /^\/checkpoint(?:\/|$)/,
];

const FACEBOOK_CONTENT_PATHS = [
  /^\/messages(?:\/|$)/,
];

const LEGACY_CONTENT_PATHS = [
  /^\/$/,
  /^\/t(?:\/|$)/,
];

function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8192) {
    return null;
  }

  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isAllowedAppUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return false;

  const hostname = url.hostname.toLowerCase();
  if (FACEBOOK_HOSTS.has(hostname)) {
    return FACEBOOK_APP_PATHS.some((pattern) => pattern.test(url.pathname));
  }

  return MESSENGER_HOSTS.has(hostname)
    && LEGACY_APP_PATHS.some((pattern) => pattern.test(url.pathname));
}

function isAllowedContentUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return false;

  const hostname = url.hostname.toLowerCase();
  if (FACEBOOK_HOSTS.has(hostname)) {
    return FACEBOOK_CONTENT_PATHS.some((pattern) => pattern.test(url.pathname));
  }

  return MESSENGER_HOSTS.has(hostname)
    && LEGACY_CONTENT_PATHS.some((pattern) => pattern.test(url.pathname));
}

function isSafeExternalUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url || url.username || url.password) return false;

  if (url.protocol === 'https:') return true;
  if (url.protocol === 'mailto:') return url.pathname.length > 0;
  return false;
}

function classifyNavigationUrl(rawUrl) {
  if (isAllowedAppUrl(rawUrl)) return 'internal';
  if (isSafeExternalUrl(rawUrl)) return 'external';
  return 'blocked';
}

function parseUnreadCountFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = /^\s*\((\d{1,4})\)(?:\s|$)/.exec(title);
  if (!match) return null;

  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count <= MAX_UNREAD_COUNT ? count : null;
}

function getTitleUnreadHint(title) {
  const count = parseUnreadCountFromTitle(title);
  return count === null
    ? { available: false, count: 0 }
    : { available: true, count };
}

function isExpectedNavigationAbort(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === 'ERR_ABORTED'
    || error.code === -3
    || error.errno === -3;
}

function permitUnloadForApplicationQuit(event, isQuitting) {
  if (isQuitting !== true || typeof event?.preventDefault !== 'function') return false;
  event.preventDefault();
  return true;
}

function isOwnedTemporaryFileName(fileName) {
  return typeof fileName === 'string'
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && OWNED_TEMP_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function normalizeRequestedMediaTypes(details = {}) {
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes;
  if (details.mediaType === 'audio' || details.mediaType === 'video') return [details.mediaType];
  // Electron 41 explicitly uses "unknown" (or omits the field) for a
  // preliminary media permission check. Keep that distinguishable from a
  // future concrete capture type, which must fail closed.
  if (details.mediaType === undefined || details.mediaType === null || details.mediaType === 'unknown') {
    return undefined;
  }
  return [];
}

function shouldHandleUpdateAvailable({ isQuitting, updatePromptOpen, updatePhase } = {}) {
  return isQuitting !== true
    && updatePromptOpen !== true
    && ['idle', 'checking', 'available'].includes(updatePhase);
}

function soundHeaderMatchesExtension(header, rawExtension) {
  if (!Buffer.isBuffer(header)) return false;
  const extension = typeof rawExtension === 'string' ? rawExtension.toLowerCase() : '';
  switch (extension) {
    case '.mp3':
      return header.subarray(0, 3).toString('ascii') === 'ID3'
        || (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
    case '.wav':
      return header.length >= 12
        && header.subarray(0, 4).toString('ascii') === 'RIFF'
        && header.subarray(8, 12).toString('ascii') === 'WAVE';
    case '.ogg':
      return header.subarray(0, 4).toString('ascii') === 'OggS';
    case '.m4a':
      return header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp';
    default:
      return false;
  }
}

function isAllowedPermissionRequest({ permission, requestingUrl, isMainFrame, mediaTypes }) {
  if (isMainFrame !== true || !isAllowedContentUrl(requestingUrl)) return false;

  switch (permission) {
    case 'notifications':
    case 'clipboard-sanitized-write':
      return true;
    case 'media': {
      // A missing list is Electron's trusted preliminary audio/video check.
      // Concrete requests remain constrained to a non-empty audio/video list.
      if (mediaTypes === undefined) return true;
      if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return false;
      return mediaTypes.every((type) => type === 'audio' || type === 'video');
    }
    default:
      return false;
  }
}

function decodeBadgePng(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;

  const encoded = match[1];
  if (encoded.length === 0 || encoded.length > Math.ceil(MAX_BADGE_PNG_BYTES / 3) * 4) {
    return null;
  }

  let bytes;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }

  if (bytes.length < 24 || bytes.length > MAX_BADGE_PNG_BYTES) return null;
  if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 64 || height > 64) return null;

  return bytes;
}

function createUsableBadgeImage(dataUrl, createImage) {
  if (typeof createImage !== 'function') return null;
  try {
    const image = createImage(dataUrl);
    if (!image || typeof image.isEmpty !== 'function' || typeof image.getSize !== 'function') {
      return null;
    }
    const size = image.getSize();
    if (image.isEmpty()
      || !Number.isFinite(size?.width)
      || !Number.isFinite(size?.height)
      || size.width < 1
      || size.height < 1
      || size.width > 64
      || size.height > 64) {
      return null;
    }
    return image;
  } catch {
    return null;
  }
}

function validateUnreadStatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Number.isSafeInteger(payload.count) || payload.count < 0 || payload.count > MAX_UNREAD_COUNT) {
    return null;
  }
  if (typeof payload.notify !== 'boolean') return null;

  let badgeDataUrl = null;
  if (payload.badgeDataUrl !== null && payload.badgeDataUrl !== undefined) {
    // The badge is decorative. A canvas/native decoding failure must never
    // veto a valid count update or its notification sound.
    if (decodeBadgePng(payload.badgeDataUrl)) badgeDataUrl = payload.badgeDataUrl;
  }

  return {
    count: payload.count,
    notify: payload.count > 0 && payload.notify,
    badgeDataUrl: payload.count > 0 ? badgeDataUrl : null,
  };
}

module.exports = {
  MAX_BADGE_PNG_BYTES,
  MAX_UNREAD_COUNT,
  classifyNavigationUrl,
  createUsableBadgeImage,
  decodeBadgePng,
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
};
