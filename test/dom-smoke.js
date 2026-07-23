'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-dom-smoke-'));
app.setPath('userData', smokeUserData);

const profileCleanupSource = String.raw`
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const target = path.resolve(process.argv[1] || '');
  const parentPid = Number(process.argv[2]);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('messenger-dom-smoke-')) {
    process.exit(2);
  }
  let attempts = 0;
  const timer = setInterval(() => {
    if (Number.isSafeInteger(parentPid) && parentPid > 0) {
      try { process.kill(parentPid, 0); return; } catch {}
    }
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      clearInterval(timer);
      process.exit(0);
    } catch {
      attempts += 1;
      if (attempts >= 50) {
        clearInterval(timer);
        process.exit(1);
      }
    }
  }, 100);
`;

function scheduleProfileCleanup() {
  try {
    const helper = spawn(
      process.execPath,
      ['-e', profileCleanupSource, smokeUserData, String(process.pid)],
      {
        detached: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    helper.unref();
  } catch {
    // The OS temp directory remains the safe fallback if helper startup fails.
  }
}

const publishedStates = [];
ipcMain.on('publish-unread-state', (_event, payload) => {
  const state = {
    count: payload?.count,
    notify: payload?.notify,
    hasBadge: typeof payload?.badgeDataUrl === 'string',
  };
  if (payload?.message) state.message = payload.message;
  publishedStates.push(state);
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function fixtureHtml() {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        html, body { width: 100%; height: 100%; margin: 0; overflow: auto; font-family: sans-serif; }
        #top { height: 56px; width: 100%; background: #222; }
        #app { position: absolute; inset: 56px 0 auto 0; height: calc(100vh - 56px); display: flex; overflow: hidden; }
        nav { flex: 0 0 320px; width: 320px; height: 100%; background: #18191a; overflow: auto; }
        nav[style*="display: none"] { display: none !important; }
        a.thread { position: relative; display: flex; height: 64px; align-items: center; color: white; }
        a.thread img { width: 40px; height: 40px; }
        main { flex: 1 1 auto; min-width: 0; height: 100%; background: #242526; overflow: hidden; }
        [role="region"] { display: flex; flex-direction: column; height: calc(100% - 24px); max-height: calc(100vh - 100px); }
        .messages { flex: 1 1 auto; min-height: 0; }
        .composer { flex: 0 0 60px; height: 60px; }
        [role="textbox"] { display: block; width: calc(100% - 40px); height: 36px; }
      </style>
    </head>
    <body>
      <header id="top" role="banner">Facebook chrome</header>
      <div id="app">
        <nav id="cached-nav" role="navigation" aria-label="Conversation list" style="display: none">
          <a class="thread" href="https://www.facebook.com/messages/t/cached">
            <img alt=""><span dir="auto">Cached</span><span dir="auto">Old</span>
            <button aria-label="Mark as unread"></button>
          </a>
        </nav>
        <nav id="live-nav" role="navigation" aria-label="Conversation list">
          <h1>Chats</h1><div role="search"><input></div>
          <a id="row-a" class="thread" data-unread="true" href="https://www.facebook.com/messages/t/a">
            <img alt=""><span dir="auto">Alice</span><span id="preview-a" dir="auto"></span><span id="status-a" dir="auto">Před 1 min</span>
            <button id="read-a" aria-label="Mark as read"></button>
          </a>
          <a id="row-b" class="thread" href="https://www.facebook.com/messages/t/b">
            <img alt=""><span dir="auto">Bob</span><span dir="auto">Seen</span>
            <button data-testid="mark_unread" aria-label="Mark as unread"></button>
          </a>
          <a id="startup-read-row" class="thread" href="https://www.facebook.com/messages/t/startup-read">
            <img alt=""><span dir="auto">Startup</span><span id="startup-read-preview" dir="auto"></span>
            <button aria-label="Mark as unread"></button>
          </a>
          <button aria-label="Inbox switcher">Inbox</button>
        </nav>
        <main id="main" role="main">
          <section id="region" role="region">
            <div class="messages">Messages</div>
            <div class="composer"><div role="textbox" contenteditable="true"></div></div>
          </section>
        </main>
      </div>
    </body>
  </html>`;
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: 1200,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const executeJavaScript = win.webContents.executeJavaScript.bind(win.webContents);
  let executedScriptCount = 0;
  win.webContents.executeJavaScript = async (source, ...args) => {
    executedScriptCount += 1;
    try {
      return await executeJavaScript(source, ...args);
    } catch (error) {
      const excerpt = String(source).replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new Error(`renderer script #${executedScriptCount} failed (${excerpt}): ${error.message}`);
    }
  };
  let focusSink = null;

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml())}`);

    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#live-nav')?.hasAttribute('data-messenger-app-nav')
      && document.querySelector('#app')?.hasAttribute('data-messenger-app-viewport-root')
      && document.querySelectorAll('[data-messenger-app-resize-handle]').length === 1
    `), 'preload did not mount the visible layout');
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'initial unread state missing');

    const initial = publishedStates.findLast((state) => state.count === 1);
    assert.deepEqual(initial, { count: 1, notify: false, hasBadge: true });

    // Meta can mount a read conversation as a name-only skeleton and hydrate
    // its months-old preview afterward. A read row can be rehydrated more than
    // once, but without an unread transition none of those changes is new.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#startup-read-preview').textContent = 'Zpráva před několika měsíci';
    `);
    await delay(1200);
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      'startup hydration of an old read-row preview generated a notification',
    );

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#startup-read-preview').textContent = 'Druhá fáze staré hydratace';
    `);
    await delay(1200);
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      'later hydration of a stable read row generated a notification',
    );

    // Normal background unread transitions must still notify.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Background unread message';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.threadId === 'b'),
      'background unread message was suppressed',
    );
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === 1 && !state.notify),
      'background message cleanup missing',
    );

    // A changed preview that remains read must not create a Windows toast the
    // app cannot represent as unread. A following unread marker is tested
    // separately below.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Background read-row message';
    `);
    await delay(1200);
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      'background read-row change generated a toast without becoming unread',
    );
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);

    // A read-row change observed while the user is actively looking at the
    // app must not become a delayed toast merely because they alt-tab during
    // the one-second unread-marker grace window.
    win.show();
    win.focus();
    win.webContents.focus();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'visible' && document.hasFocus()`,
    ), 'test window did not become focused');
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Focused read-row change';
    `);
    await delay(150);
    win.hide();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'hidden' || !document.hasFocus()`,
    ), 'test window did not enter the background');
    await delay(1050);
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      `focused read-row change notified after a later alt-tab: ${JSON.stringify(publishedStates)}`,
    );
    win.show();
    focusSink = new BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      opacity: 0,
      width: 1,
      height: 1,
      x: -32000,
      y: -32000,
    });
    await focusSink.loadURL('data:text/html,<title>focus sink</title>');
    focusSink.show();
    focusSink.focus();
    focusSink.webContents.focus();
    await delay(250);
    const backgroundRenderState = {
      document: await win.webContents.executeJavaScript(`({
        focus: document.hasFocus(),
        visibility: document.visibilityState,
      })`),
      sinkFocused: focusSink.isFocused(),
      windowFocused: win.isFocused(),
      windowVisible: win.isVisible(),
    };
    assert.ok(
      backgroundRenderState.document.visibility === 'visible'
        && backgroundRenderState.document.focus === false,
      `test window did not resume rendering in the background: ${JSON.stringify(backgroundRenderState)}`,
    );

    // The inverse focus race matters too: a read-row preview can change while
    // hidden, then the user can inspect the app and hide it again before the
    // one-second marker-lag timer expires. That already-observed message must
    // not appear as a stale toast after the second background transition.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Interrupted background read-row message';
    `);
    await delay(150);
    win.focus();
    win.webContents.focus();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'visible' && document.hasFocus()`,
    ), 'test window did not regain focus during the read-row grace');
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Foreground baseline after interruption';
    `);
    await delay(100);
    focusSink.focus();
    focusSink.webContents.focus();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'hidden' || !document.hasFocus()`,
    ), 'test window did not return to the background');
    await delay(1050);
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      `focus-interrupted read-row message generated a stale toast: ${JSON.stringify(publishedStates)}`,
    );
    await win.webContents.executeJavaScript(`document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen'`);

    const geometry = await win.webContents.executeJavaScript(`(() => {
      const viewport = window.visualViewport?.height || window.innerHeight;
      const root = document.querySelector('[data-messenger-app-viewport-root]');
      const editor = document.querySelector('[role="textbox"]');
      return {
        viewport,
        rootHeight: root.getBoundingClientRect().height,
        rootTop: root.getBoundingClientRect().top,
        editorBottom: editor.closest('[role="region"]').getBoundingClientRect().bottom,
        bannerHidden: getComputedStyle(document.querySelector('#top')).display === 'none',
        documentOverflow: document.documentElement.scrollHeight - viewport,
        activeNav: document.querySelector('[data-messenger-app-nav]')?.id,
        threadTagged: document.querySelector('#region').hasAttribute('data-messenger-app-thread-fill'),
      };
    })()`);
    assert.equal(geometry.bannerHidden, true);
    assert.equal(geometry.activeNav, 'live-nav');
    assert.equal(geometry.threadTagged, true);
    assert.ok(Math.abs(geometry.rootHeight - (geometry.viewport - 5)) <= 1, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.rootTop) <= 1, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.editorBottom - (geometry.viewport - 5)) <= 1, JSON.stringify(geometry));
    assert.ok(geometry.documentOverflow <= 0.5, JSON.stringify(geometry));

    const styleLoopResult = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(document.querySelector('#app'), { attributes: true, attributeFilter: ['style'] });
      observer.observe(document.querySelector('#live-nav'), { attributes: true, attributeFilter: ['style'] });
      setTimeout(() => { observer.disconnect(); resolve(mutations); }, 250);
    })`);
    assert.equal(styleLoopResult, 0, 'layout coordinator kept mutating its own styles after settling');

    // Meta/React can reconcile attributes on nodes it owns and remove the
    // markers injected by the preload. The coordinator must restore every
    // layout-critical marker without relying on an unrelated later mutation
    // or a paint frame (hidden/occluded Electron windows suspend rAF).
    await win.webContents.executeJavaScript(`
      window.__messengerTestRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 1;
      document.querySelector('#live-nav').removeAttribute('data-messenger-app-nav');
      document.querySelector('#live-nav').removeAttribute('data-messenger-app-custom-width');
      document.querySelector('#live-nav').style.removeProperty('--messenger-app-nav-width');
      document.querySelector('#app').removeAttribute('data-messenger-app-viewport-root');
      document.querySelector('#app').removeAttribute('data-messenger-app-relative-root');
      document.querySelector('#top').removeAttribute('data-messenger-app-global-banner');
      document.querySelectorAll('[data-messenger-app-fill]').forEach((node) => {
        node.removeAttribute('data-messenger-app-fill');
      });
      document.querySelector('#region').removeAttribute('data-messenger-app-thread-fill');
      true;
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#live-nav').hasAttribute('data-messenger-app-nav')
      && document.querySelector('#live-nav').hasAttribute('data-messenger-app-custom-width')
      && document.querySelector('#live-nav').style.getPropertyValue('--messenger-app-nav-width') === '320px'
      && document.querySelector('#app').hasAttribute('data-messenger-app-viewport-root')
      && document.querySelector('#top').hasAttribute('data-messenger-app-global-banner')
      && document.querySelector('#region').hasAttribute('data-messenger-app-thread-fill')
    `), 'managed markers removed by a framework rerender were not restored');
    const recoveredGeometry = await win.webContents.executeJavaScript(`(() => ({
      rootTop: document.querySelector('#app').getBoundingClientRect().top,
      rootHeight: document.querySelector('#app').getBoundingClientRect().height,
      viewport: window.visualViewport?.height || window.innerHeight,
      bannerHidden: getComputedStyle(document.querySelector('#top')).display === 'none',
    }))()`);
    assert.ok(Math.abs(recoveredGeometry.rootTop) <= 1, JSON.stringify(recoveredGeometry));
    assert.ok(
      Math.abs(recoveredGeometry.rootHeight - (recoveredGeometry.viewport - 5)) <= 1,
      JSON.stringify(recoveredGeometry),
    );
    assert.equal(recoveredGeometry.bannerHidden, true);
    await win.webContents.executeJavaScript(`
      window.requestAnimationFrame = window.__messengerTestRequestAnimationFrame;
      delete window.__messengerTestRequestAnimationFrame;
    `);

    // Meta can reapply a post-header body height and its own important page
    // overflow after mount. It must not recreate a global scrollbar or retain
    // a body scroll offset that shifts the whole Messenger shell upward.
    await win.webContents.executeJavaScript(`
      document.body.style.setProperty('height', 'calc(100% - 56px)', 'important');
      document.body.style.setProperty('max-height', 'calc(100% - 56px)', 'important');
      document.body.style.setProperty('overflow-y', 'auto', 'important');
      document.body.scrollTop = 100;
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`(() => {
      const viewport = window.visualViewport?.height || window.innerHeight;
      const root = document.querySelector('[data-messenger-app-viewport-root]').getBoundingClientRect();
      const bodyStyle = getComputedStyle(document.body);
      return Math.abs(document.body.getBoundingClientRect().height - viewport) <= 1
        && bodyStyle.overflowY === 'clip'
        && document.body.scrollTop === 0
        && Math.abs(root.top) <= 1
        && Math.abs(root.bottom - (viewport - 5)) <= 1;
    })()`), 'global body scrollbar/offset returned after Meta style reconciliation');

    // A real React shell replacement can disconnect the old navigation, mount
    // an empty skeleton in a later task, and hydrate rows after that. Preserve
    // the last unread snapshot across the fixed handoff grace instead of
    // publishing a transient zero.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__detachedLiveNav = document.querySelector('#live-nav');
      window.__detachedLiveNav.remove();
    `);
    await delay(150);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'nav disconnect published zero before grace');
    await win.webContents.executeJavaScript(`(() => {
      const skeleton = document.createElement('nav');
      skeleton.id = 'live-nav';
      skeleton.setAttribute('role', 'navigation');
      skeleton.setAttribute('aria-label', 'Conversation list');
      skeleton.innerHTML = '<h1>Loading chats</h1>';
      document.querySelector('#main').before(skeleton);
    })()`);
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.querySelector('#live-nav')?.hasAttribute('data-messenger-app-nav')`,
    ), 'empty replacement nav did not mount');
    await delay(150);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'empty replacement skeleton published zero');
    const skeletonHydration = await win.webContents.executeJavaScript(`(() => {
      try {
        const skeleton = document.querySelector('#live-nav');
        const detached = window.__detachedLiveNav;
        if (!skeleton || !detached) return { error: 'missing skeleton or detached nav' };
        skeleton.replaceChildren();
        while (detached.firstChild) skeleton.appendChild(detached.firstChild);
        delete window.__detachedLiveNav;
        return { ok: true };
      } catch (error) {
        return { error: String(error?.stack || error) };
      }
    })()`);
    assert.deepEqual(skeletonHydration, { ok: true });
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#row-a')?.hasAttribute('data-messenger-app-unread')
      && document.querySelector('#app')?.hasAttribute('data-messenger-app-viewport-root')
    `), 'replacement nav rows did not hydrate');
    await delay(1050);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'stale shell handoff timer cleared a hydrated nav');
    assert.equal(publishedStates.some((state) => state.notify), false, 'shell handoff generated a notification');

    // Meta can keep its previous list connected but hidden while a visible
    // replacement already has thread anchors whose unread state is not yet
    // hydrated. This is still a handoff, so the read-looking skeleton must not
    // erase the previous unread snapshot.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`(() => {
      const oldNav = document.querySelector('#live-nav');
      oldNav.id = 'connected-old-nav';
      oldNav.setAttribute('aria-hidden', 'true');
      const skeleton = document.createElement('nav');
      skeleton.id = 'live-nav';
      skeleton.setAttribute('role', 'navigation');
      skeleton.setAttribute('aria-label', 'Conversation list');
      skeleton.innerHTML = '<h1>Loading connected replacement</h1><a href="/messages/t/hydrating"><span dir="auto">Hydrating</span><span dir="auto">Read</span><button aria-label="Mark as unread"></button></a>';
      document.querySelector('#main').before(skeleton);
      window.__connectedHandoffOld = oldNav;
    })()`);
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.querySelector('#live-nav')?.hasAttribute('data-messenger-app-nav')`,
    ), 'connected hydrating replacement nav did not mount');
    await delay(150);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'connected hydrating replacement published zero');
    const connectedHydration = await win.webContents.executeJavaScript(`(() => {
      try {
        const skeleton = document.querySelector('#live-nav');
        const oldNav = window.__connectedHandoffOld;
        if (!skeleton || !oldNav) return { error: 'missing connected skeleton or old nav' };
        skeleton.replaceChildren();
        while (oldNav.firstChild) skeleton.appendChild(oldNav.firstChild);
        oldNav.remove();
        delete window.__connectedHandoffOld;
        return { ok: true };
      } catch (error) {
        return { error: String(error?.stack || error) };
      }
    })()`);
    assert.deepEqual(connectedHydration, { ok: true });
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#row-a')?.hasAttribute('data-messenger-app-unread')
      && document.querySelector('#app')?.hasAttribute('data-messenger-app-viewport-root')
    `), 'connected replacement nav rows did not hydrate');
    await delay(1050);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'connected handoff timer cleared a hydrated nav');
    assert.equal(publishedStates.some((state) => state.notify), false, 'connected shell handoff generated a notification');

    // A message can land after React disconnects the old list but before its
    // replacement hydrates. Compare the replacement against the retained
    // stable rows so that transition is not swallowed as a fresh baseline.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__messageGapNav = document.querySelector('#live-nav');
      window.__messageGapNav.remove();
    `);
    await delay(150);
    await win.webContents.executeJavaScript(`(() => {
      const detached = window.__messageGapNav;
      const row = detached.querySelector('#row-b');
      row.setAttribute('data-unread', 'true');
      row.querySelector('button').setAttribute('aria-label', 'Mark as read');
      row.querySelectorAll('[dir="auto"]')[1].textContent = 'Message committed during nav handoff';
      const replacement = document.createElement('nav');
      replacement.id = 'live-nav';
      replacement.setAttribute('role', 'navigation');
      replacement.setAttribute('aria-label', 'Conversation list');
      while (detached.firstChild) replacement.appendChild(detached.firstChild);
      document.querySelector('#main').before(replacement);
      delete window.__messageGapNav;
    })()`);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Message committed during nav handoff'),
      'message committed during a disconnected nav handoff was missed',
    );
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(250);

    // The source tracker may already have queued its 180 ms stable-message
    // timer when the nav disconnects. Transfer that intent as well as row state
    // so cleanup cannot silently eat a just-observed message.
    win.focus();
    win.webContents.focus();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'visible' && document.hasFocus()`,
    ), 'test window did not focus before pending-handoff setup');
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Pending handoff baseline';
    `);
    await delay(250);
    focusSink.focus();
    focusSink.webContents.focus();
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.visibilityState === 'hidden' || !document.hasFocus()`,
    ), 'test window did not background before pending-handoff setup');
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('#live-nav');
      const row = nav.querySelector('#row-b');
      row.setAttribute('data-unread', 'true');
      row.querySelector('button').setAttribute('aria-label', 'Mark as read');
      row.querySelectorAll('[dir="auto"]')[1].textContent = 'Pending toast across nav handoff';
      setTimeout(() => {
        nav.remove();
        setTimeout(() => {
          const replacement = document.createElement('nav');
          replacement.id = 'live-nav';
          replacement.setAttribute('role', 'navigation');
          replacement.setAttribute('aria-label', 'Conversation list');
          while (nav.firstChild) replacement.appendChild(nav.firstChild);
          document.querySelector('#main').before(replacement);
        }, 40);
      }, 40);
    })()`);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Pending toast across nav handoff'),
      'pending message toast was lost when its source nav disconnected',
    );
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(250);

    // A permanently absent nav must still retire after the original deadline;
    // unrelated structure reconciles cannot keep extending that deadline.
    publishedStates.length = 0;
    const permanentGapStartedAt = Date.now();
    await win.webContents.executeJavaScript(`
      window.__permanentGapNav = document.querySelector('#live-nav');
      window.__permanentGapNav.remove();
      [150, 400, 750].forEach((delayMs, index) => {
        setTimeout(() => document.body.classList.toggle('gap-pulse-' + index), delayMs);
      });
    `);
    await delay(250);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'permanent gap decremented before grace');
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'permanent nav gap never retired');
    assert.ok(Date.now() - permanentGapStartedAt < 1600, 'structure mutations extended the original gap deadline');
    await delay(250);
    assert.equal(
      publishedStates.filter((state) => state.count === 0).length,
      1,
      'permanent nav gap published zero more than once',
    );
    await win.webContents.executeJavaScript(`
      document.body.classList.remove('gap-pulse-0', 'gap-pulse-1', 'gap-pulse-2');
      document.querySelector('#main').before(window.__permanentGapNav);
      delete window.__permanentGapNav;
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'restored nav baseline missing after permanent gap');
    assert.equal(publishedStates.findLast((state) => state.count === 1).notify, false);

    await win.webContents.executeJavaScript(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.body.classList.contains('messenger-app-compact')
      && document.body.classList.contains('messenger-app-menu-hidden')
    `), 'compact/menu modes did not activate');
    await win.webContents.executeJavaScript(`
      const search = document.createElement('div');
      search.id = 'replaced-search';
      search.setAttribute('role', 'search');
      search.innerHTML = '<input aria-label="Search">';
      document.querySelector('#live-nav [role="search"]').replaceWith(search);
      const inbox = document.createElement('button');
      inbox.id = 'replaced-inbox';
      inbox.setAttribute('aria-label', 'Inbox switcher');
      inbox.textContent = 'Inbox replacement';
      document.querySelector('#live-nav [aria-label="Inbox switcher"]').replaceWith(inbox);
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#replaced-search').hasAttribute('data-messenger-app-compact-hide')
      && document.querySelector('#replaced-inbox').hasAttribute('data-messenger-app-menu')
      && getComputedStyle(document.querySelector('#replaced-search')).display === 'none'
      && getComputedStyle(document.querySelector('#replaced-inbox')).display === 'none'
      && getComputedStyle(document.querySelector('#row-a')).display !== 'none'
    `), 'rerendered scoped controls escaped compact/menu hiding');
    await win.webContents.executeJavaScript(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
    `);

    await win.setContentSize(400, 800);
    await waitFor(async () => {
      const width = await win.webContents.executeJavaScript(
        `document.querySelector('#live-nav').getBoundingClientRect().width`,
      );
      return width <= 121 && width >= 0;
    }, 'navigation width was not clamped for a 400px viewport');
    const narrow = await win.webContents.executeJavaScript(`(() => ({
      nav: document.querySelector('#live-nav').getBoundingClientRect().width,
      main: document.querySelector('#main').getBoundingClientRect().width,
      handleX: document.querySelector('[data-messenger-app-resize-handle]').getBoundingClientRect().left + 4,
    }))()`);
    assert.ok(narrow.main >= 279, JSON.stringify(narrow));

    // A click without a drag at the clamped width must not overwrite the saved
    // preferred width; expanding the viewport should still restore 320px.
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(narrow.handleX), y: 100, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(narrow.handleX), y: 100, button: 'left', clickCount: 1 });
    await delay(50);

    await win.setContentSize(1200, 800);
    await waitFor(async () => {
      const width = await win.webContents.executeJavaScript(
        `document.querySelector('#live-nav').getBoundingClientRect().width`,
      );
      return Math.abs(width - 320) <= 1;
    }, 'preferred navigation width was not restored after viewport expansion');

    const wideHandleX = await win.webContents.executeJavaScript(
      `document.querySelector('[data-messenger-app-resize-handle]').getBoundingClientRect().left + 4`,
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(wideHandleX), y: 100, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(wideHandleX + 80), y: 100, button: 'left' });
    await delay(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(wideHandleX + 80), y: 100, button: 'left', clickCount: 1 });
    await waitFor(async () => win.webContents.executeJavaScript(
      `Math.abs(document.querySelector('#live-nav').getBoundingClientRect().width - 400) <= 2`,
    ), 'drag resize was reverted by the structure observer');
    await delay(150);
    assert.ok(await win.webContents.executeJavaScript(
      `Math.abs(document.querySelector('#live-nav').getBoundingClientRect().width - 400) <= 2`,
    ), 'dragged width did not remain stable after pointerup');

    // Complete a startup skeleton after a long delay. Its first stable preview
    // is still baseline hydration, without suppressing unrelated early messages.
    win.webContents.send('title-unread-hint', { available: true, count: 0 });
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(1550);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Hello'`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'late startup row hydration generated a notification');

    // An aria-hidden overlay can temporarily hide the connected shell for
    // longer than the replacement grace. Keep the unread tracker alive so a
    // message arriving behind that overlay is not converted into a baseline.
    await win.webContents.executeJavaScript(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.body.classList.contains('messenger-app-compact')
      && document.body.classList.contains('messenger-app-menu-hidden')
      && getComputedStyle(document.querySelector('#replaced-search')).display === 'none'
      && getComputedStyle(document.querySelector('#replaced-inbox')).display === 'none'
    `), 'compact/menu modes did not reactivate before connected overlay');
    await win.webContents.executeJavaScript(`
      document.querySelector('#live-nav').setAttribute('aria-hidden', 'true');
      document.querySelector('#main').setAttribute('aria-hidden', 'true');
    `);
    await delay(1100);
    assert.equal(publishedStates.some((state) => state.count === 0), false, 'connected hidden shell cleared the unread count');
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Message behind overlay';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === 2 && state.notify),
      'connected hidden tracker missed a new message',
    );
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#live-nav').removeAttribute('aria-hidden');
      document.querySelector('#main').removeAttribute('aria-hidden');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'hidden tracker read transition missing');
    assert.equal(publishedStates.findLast((state) => state.count === 1).notify, false);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.body.classList.contains('messenger-app-mounted')
      && document.querySelector('#app').hasAttribute('data-messenger-app-viewport-root')
      && document.body.classList.contains('messenger-app-compact')
      && document.body.classList.contains('messenger-app-menu-hidden')
      && getComputedStyle(document.querySelector('#replaced-search')).display === 'none'
      && getComputedStyle(document.querySelector('#replaced-inbox')).display === 'none'
    `), 'layout did not resume after connected overlay');
    await win.webContents.executeJavaScript(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      !document.body.classList.contains('messenger-app-compact')
      && !document.body.classList.contains('messenger-app-menu-hidden')
    `), 'compact/menu state desynchronized across connected overlay');

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__messengerTestRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 1;
      true;
    `);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'false');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as unread');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'read transition missing');
    assert.equal(publishedStates.findLast((state) => state.count === 0).notify, false);

    // The unread marker alone is also produced by the user's "Mark as
    // unread" action. An unchanged preview must never look like a new message.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'true');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as read');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'manual unread transition missing');
    await delay(250);
    assert.equal(publishedStates.some((state) => state.notify), false, 'manual Mark as unread generated a toast');
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'false');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as unread');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'manual unread reset missing');

    // Meta can commit the preview first and the unread marker in the following
    // observer batch. Preserve that short-lived read-row change as a candidate.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Preview-first message'`);
    await delay(50);
    assert.equal(publishedStates.some((state) => state.notify), false, 'read preview notified before unread marker');
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'true');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as read');
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.body === 'Preview-first message'),
      'preview-first/unread-second message was missed',
    );
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'false');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as unread');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'preview-first cleanup missing');

    // The DOM message can arrive before a lagging title prefix changes from
    // zero. The stale title must not erase the only toast/sound event.
    win.webContents.send('title-unread-hint', { available: true, count: 0 });
    await delay(25);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'true');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#preview-a').textContent = 'New hello';
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1 && state.notify), 'read-to-unread notification missing');
    assert.deepEqual(
      publishedStates.findLast((state) => state.count === 1 && state.notify).message,
      {
        threadId: 'a',
        encrypted: false,
        title: 'Alice',
        body: 'New hello',
      },
    );
    const domFirstNotificationCount = publishedStates.filter((state) => state.notify).length;
    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await delay(100);
    assert.equal(
      publishedStates.filter((state) => state.notify).length,
      domFirstNotificationCount,
      'later title update duplicated a DOM message toast',
    );
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await win.webContents.executeJavaScript(`
      window.requestAnimationFrame = window.__messengerTestRequestAnimationFrame;
      delete window.__messengerTestRequestAnimationFrame;
    `);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Another hello'`);
    await waitFor(() => publishedStates.some((state) => state.count === 1 && state.notify), 'already-unread message signature change missing');
    assert.equal(
      publishedStates.findLast((state) => state.count === 1 && state.notify).message.body,
      'Another hello',
    );

    // Facebook title counts are useful for the badge but carry no sender or
    // preview. They must never create message toasts or sounds; a following
    // DOM-confirmed message must still retain its rich metadata.
    await delay(1050);
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await delay(50);
    assert.equal(publishedStates.some((state) => state.notify), false, 'first title value after an unavailable gap notified');
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 2 });
    await waitFor(() => publishedStates.some((state) => state.count === 2), 'title badge update missing');
    const titleOnlyState = publishedStates.findLast((state) => state.count === 2);
    assert.equal(titleOnlyState.notify, false);
    assert.equal(Object.hasOwn(titleOnlyState, 'message'), false);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Different message after title event'`);
    await waitFor(
      () => publishedStates.some((state) => state.count === 2 && state.notify && state.message),
      'DOM-confirmed message after a title update lost its toast metadata',
    );
    assert.deepEqual(
      publishedStates.findLast((state) => state.message).message,
      {
        threadId: 'a',
        encrypted: false,
        title: 'Alice',
        body: 'Different message after title event',
      },
    );
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'following title badge update missing');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, false);
    assert.equal(publishedStates.some((state) => state.message), false);

    // A different thread still produces exactly one DOM-owned message toast
    // while a title count remains available.
    await win.webContents.executeJavaScript(`
      window.__crossSourceRow = document.createElement('a');
      window.__crossSourceRow.className = 'thread';
      window.__crossSourceRow.href = 'https://www.facebook.com/messages/e2ee/t/cross-source';
      window.__crossSourceRow.innerHTML = '<img alt=""><span dir="auto">Žluťoučký chat</span><span dir="auto">Read</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__crossSourceRow);
    `);
    await delay(350);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__crossSourceRow.setAttribute('data-unread', 'true');
      window.__crossSourceRow.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__crossSourceRow.querySelectorAll('[dir="auto"]')[1].textContent = 'Distinct DOM-first message';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === 3 && state.notify && state.message),
      'title badge masked a DOM-confirmed message',
    );
    assert.deepEqual(publishedStates.findLast((state) => state.message).message, {
      threadId: 'cross-source',
      encrypted: true,
      title: 'Žluťoučký chat',
      body: 'Distinct DOM-first message',
    });
    await win.webContents.executeJavaScript(`
      window.__crossSourceRow.setAttribute('data-unread', 'false');
      window.__crossSourceRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__crossSourceRow.remove();
      delete window.__crossSourceRow;
    `);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(50);

    publishedStates.length = 0;
    for (const timestamp of [
      'Před 59 min',
      'Před 1 hod',
      'Před 1 dnem',
      'Před 2 dny',
      'Před týdnem',
      'Před 2 týdny',
      'Před měsícem',
      'Před 2 měsíci',
      'Právě teď',
      'Just now',
      'Po',
      'Monday',
      '20. 7.',
      'Jul 20',
    ]) {
      await win.webContents.executeJavaScript(
        `document.querySelector('#status-a').textContent = ${JSON.stringify(timestamp)}`,
      );
      await delay(25);
    }
    await delay(250);
    assert.equal(publishedStates.length, 0, 'relative time/date rollover generated a notification');

    // Meta sometimes appends an empty accessibility/helper node after the
    // timestamp. Its presence must not turn a time rollover into message text.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__timestampAux = document.createElement('span');
      window.__timestampAux.setAttribute('dir', 'auto');
      document.querySelector('#row-a').appendChild(window.__timestampAux);
      document.querySelector('#status-a').textContent = 'Právě teď';
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`document.querySelector('#status-a').textContent = 'Před 1 min'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'timestamp before a trailing helper node generated a notification');
    await win.webContents.executeJavaScript(`window.__timestampAux.remove()`);

    // A partially hydrated row may expose only its title and timestamp. A
    // timestamp rollover is still transient even in that two-node skeleton.
    await win.webContents.executeJavaScript(`
      window.__calendarSkeleton = document.createElement('a');
      window.__calendarSkeleton.className = 'thread';
      window.__calendarSkeleton.href = 'https://www.facebook.com/messages/t/calendar-skeleton';
      window.__calendarSkeleton.setAttribute('data-unread', 'true');
      window.__calendarSkeleton.innerHTML = '<span dir="auto">Kalendář skeleton</span><span dir="auto">Právě teď</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(window.__calendarSkeleton);
    `);
    await delay(300);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`window.__calendarSkeleton.querySelectorAll('[dir="auto"]')[1].textContent = 'Před 1 min'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'two-node timestamp skeleton generated a notification');
    await win.webContents.executeJavaScript(`window.__calendarSkeleton.querySelectorAll('[dir="auto"]')[1].textContent = '1 min ago'`);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__calendarSkeleton.querySelectorAll('[dir="auto"]')[1].textContent = '2 min ago'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'English two-node timestamp skeleton generated a notification');
    await win.webContents.executeJavaScript(`
      window.__calendarSkeleton.setAttribute('data-unread', 'false');
      window.__calendarSkeleton.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__calendarSkeleton.remove();
    `);

    // Conversely, a trailing calendar-looking word after an explicit sender
    // prefix is a real body, not a status slot.
    await win.webContents.executeJavaScript(`
      window.__calendarBody = document.createElement('a');
      window.__calendarBody.className = 'thread';
      window.__calendarBody.href = 'https://www.facebook.com/messages/t/calendar-body';
      window.__calendarBody.innerHTML = '<span dir="auto">Kalendář body</span><span dir="auto">Petr:</span><span dir="auto">Staré</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__calendarBody);
    `);
    await delay(300);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__calendarBody.setAttribute('data-unread', 'true');
      window.__calendarBody.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__calendarBody.querySelectorAll('[dir="auto"]')[2].textContent = 'Ne';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'calendar-body'
        && state.message?.body === 'Petr: · Ne'),
      'trailing calendar-looking message body was filtered',
    );
    await win.webContents.executeJavaScript(`
      window.__calendarBody.setAttribute('data-unread', 'false');
      window.__calendarBody.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__calendarBody.remove();
    `);

    // Once a two-node row has a stable real preview baseline, a new message is
    // allowed to look like a calendar token. The prior content distinguishes
    // this from a title+timestamp skeleton.
    await win.webContents.executeJavaScript(`
      window.__twoNodeMessage = document.createElement('a');
      window.__twoNodeMessage.className = 'thread';
      window.__twoNodeMessage.href = 'https://www.facebook.com/messages/t/two-node-message';
      window.__twoNodeMessage.innerHTML = '<span dir="auto">Dvouuzlový chat</span><span dir="auto">Starý náhled</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__twoNodeMessage);
    `);
    await delay(300);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__twoNodeMessage.setAttribute('data-unread', 'true');
      window.__twoNodeMessage.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__twoNodeMessage.querySelectorAll('[dir="auto"]')[1].textContent = 'Dnes';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'two-node-message'
        && state.message?.body === 'Dnes'),
      'calendar-looking real message in a stable two-node row was missed',
    );
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`window.__twoNodeMessage.querySelectorAll('[dir="auto"]')[1].textContent = '12:30'`);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'two-node-message'
        && state.message?.body === '12:30'),
      'time-looking real message in a stable two-node row was missed',
    );
    await win.webContents.executeJavaScript(`
      window.__twoNodeMessage.setAttribute('data-unread', 'false');
      window.__twoNodeMessage.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__twoNodeMessage.remove();
    `);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Alice is typing…'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'prefixed typing status generated a notification');
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Different message after title event'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'restoring the same preview after typing generated a notification');

    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Jan píše…'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'localized prefixed typing status generated a notification');
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Different message after title event'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'localized typing restore generated a notification');

    for (const nonMessagePreview of [
      'Dal(a) vaší zprávě To se mi líbí',
      'Alice reagoval(a) na vaši zprávu 👍',
      'Alice reagovala na vaši zprávu 👍',
      'Viděl(a) to Alice',
      'Zmeškaný hlasový hovor',
      'Zmeškaný videohovor',
      'Alice pojmenoval(a) skupinu Výlet',
      'Alice pojmenovala skupinu Výlet',
      'Alice změnila název skupiny',
      'Alice opustila skupinu',
      'Alice se připojila ke skupině',
      'Zobrazeno před 2 min',
      'Zobrazeno právě teď',
      'Seen 2m ago',
      'Seen · just now',
      'Seen 2:14 PM',
      'Seen yesterday',
      'Delivered 1m ago',
      'Delivered just now',
      'Delivered Jul 20',
      'Zobrazeno v 14:30',
      'Zobrazeno včera',
      'You unsent a message',
      'Alice unsent a message',
      'Zrušili jste odeslání zprávy',
      'Alice zrušila odeslání zprávy',
      'You missed a call',
      'Missed call',
      'Call ended',
      'The video call has ended',
      'Call failed',
      'Alice missed your video call',
      'Hovor skončil',
      'Videohovor se nezdařil',
      'Alice zmeškala váš videohovor',
      'Zprávy a hovory jsou zabezpečeny koncovým šifrováním',
      'New: Messages and calls are secured with end-to-end encryption. Only people in this chat can read, listen to, or share them. Learn more',
      'Nové zprávy a hovory jsou zabezpečeny koncovým šifrováním. Jen lidé v tomto chatu je můžou číst, poslouchat nebo sdílet. Další informace',
      'Messages are missing. Restore now',
      'Some messages are missing. Sync now',
      'Chat history is missing. Enter your PIN to restore chat history',
      'Historie chatu chybí. Zadejte svůj PIN pro obnovení historie chatu',
      'Alice changed the chat theme to Ultraviolet',
      'You changed the theme to Default',
      'Alice set the emoji to 👍',
      'Alice set your nickname to Bobe',
      'Alice změnila motiv chatu na Výchozí',
      'Alice nastavila emoji na 👍',
      'Alice nastavila vaši přezdívku na Bobe',
      'Alice pinned a message',
      'Alice unpinned a message',
      'Alice připnula zprávu',
      'Alice odepnula zprávu',
      'Alice turned on disappearing messages. Messages will disappear 24 hours after they’re sent',
      'Alice zapnula automatické odstranění zpráv',
      'Alice added Bob to the group',
      'Alice removed Bob from the group',
      'Alice přidala Boba do skupiny',
      'Alice odebrala Boba ze skupiny',
      'You are now connected on Messenger',
      'You can now message and call each other and see info like Active Status',
      'Say hi to your new Facebook friend',
      'Teď jste propojeni v Messengeru',
      'Teď si můžete posílat zprávy a volat si',
      'Sending…',
      "Couldn't send",
      'This message failed to send. Click to send again',
      'Odesílání…',
      'Tuto zprávu se nepodařilo odeslat. Kliknutím odešlete znovu',
    ]) {
      await win.webContents.executeJavaScript(
        `document.querySelector('#preview-a').textContent = ${JSON.stringify(nonMessagePreview)}`,
      );
      await delay(250);
      assert.equal(publishedStates.some((state) => state.notify), false, `${nonMessagePreview} generated a notification`);
      await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Different message after title event'`);
      await delay(250);
      assert.equal(publishedStates.some((state) => state.notify), false, 'restoring a preview after non-message activity generated a notification');
    }

    // Group previews can split the sender and transient activity into separate
    // semantic leaves. Filtering the activity must not leave "Alice:" behind
    // as an apparent message body.
    await win.webContents.executeJavaScript(`
      window.__splitActivityRow = document.createElement('a');
      window.__splitActivityRow.className = 'thread';
      window.__splitActivityRow.href = 'https://www.facebook.com/messages/t/split-activity';
      window.__splitActivityRow.innerHTML = '<span dir="auto">Skupina</span><span dir="auto">Alice:</span><span id="split-activity-preview" dir="auto">Starý náhled</span><span dir="auto">Před 1 min</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__splitActivityRow);
    `);
    await delay(300);
    for (const transientActivity of [
      'píše…',
      'reagovala na vaši zprávu 👍',
      'Zobrazeno před 2 min',
      'changed the group name',
      'změnila fotku skupiny',
      'added Bob to the group',
      'odebrala Boba ze skupiny',
      'changed the chat theme to Ultraviolet',
      'nastavila emoji na 👍',
      'set your nickname to Bobe',
      'pinned a message',
      'odepnula zprávu',
      'turned off disappearing messages',
      'zapnula automatické odstranění zpráv',
      'Call ended',
      'zmeškala váš videohovor',
      'Messages are missing. Restore now',
      'Odesílání…',
    ]) {
      publishedStates.length = 0;
      await win.webContents.executeJavaScript(`
        window.__splitActivityRow.setAttribute('data-unread', 'true');
        window.__splitActivityRow.querySelector('button').setAttribute('aria-label', 'Mark as read');
        window.__splitActivityRow.querySelectorAll('[dir="auto"]')[2].textContent = ${JSON.stringify(transientActivity)};
      `);
      await delay(300);
      assert.equal(publishedStates.some((state) => state.notify), false, `${transientActivity} split activity generated a notification`);
      await win.webContents.executeJavaScript(`
        window.__splitActivityRow.setAttribute('data-unread', 'false');
        window.__splitActivityRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
        window.__splitActivityRow.querySelectorAll('[dir="auto"]')[2].textContent = 'Starý náhled';
      `);
      await delay(250);
    }

    // The encryption notice is commonly split into independent semantic
    // leaves. Every leaf, including the generic action link, must stay
    // auxiliary or the final one would be mistaken for a message body.
    for (const [intro, detailsText, learnMoreText] of [
      [
        'New: Messages and calls are secured with end-to-end encryption.',
        'Only people in this chat can read, listen to, or share them.',
        'Learn more',
      ],
      [
        'Nové zprávy a hovory jsou zabezpečeny koncovým šifrováním.',
        'Jen lidé v tomto chatu je můžou číst, poslouchat nebo sdílet.',
        'Další informace',
      ],
    ]) {
      publishedStates.length = 0;
      await win.webContents.executeJavaScript(`(() => {
        window.__splitActivityRow.setAttribute('data-unread', 'true');
        window.__splitActivityRow.querySelector('button').setAttribute('aria-label', 'Mark as read');
        const preview = window.__splitActivityRow.querySelector('#split-activity-preview');
        preview.textContent = ${JSON.stringify(intro)};
        const details = document.createElement('span');
        details.id = 'e2ee-details';
        details.setAttribute('dir', 'auto');
        details.textContent = ${JSON.stringify(detailsText)};
        const learnMore = document.createElement('span');
        learnMore.id = 'e2ee-learn-more';
        learnMore.setAttribute('dir', 'auto');
        learnMore.textContent = ${JSON.stringify(learnMoreText)};
        preview.after(details, learnMore);
      })()`);
      await delay(300);
      assert.equal(publishedStates.some((state) => state.notify), false, `${intro} split E2EE notice generated a notification`);
      await win.webContents.executeJavaScript(`
        window.__splitActivityRow.setAttribute('data-unread', 'false');
        window.__splitActivityRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
        window.__splitActivityRow.querySelector('#split-activity-preview').textContent = 'Starý náhled';
        window.__splitActivityRow.querySelector('#e2ee-details')?.remove();
        window.__splitActivityRow.querySelector('#e2ee-learn-more')?.remove();
      `);
      await delay(250);
    }
    await win.webContents.executeJavaScript(`window.__splitActivityRow.remove()`);

    for (const outgoingPreview of ['Já: vlastní zpráva', 'Poslali jste fotku']) {
      await win.webContents.executeJavaScript(
        `document.querySelector('#preview-a').textContent = ${JSON.stringify(outgoingPreview)}`,
      );
      await delay(300);
      assert.equal(publishedStates.some((state) => state.notify), false, 'outgoing message preview generated a notification');
    }

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const preview = document.querySelector('#preview-a');
      preview.textContent = '';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        preview.textContent = 'Stable final preview';
        resolve();
      }));
    })`);
    await waitFor(() => publishedStates.some((state) => state.count === 1 && state.notify), 'staged preview update was missed');
    await delay(300);
    assert.equal(
      publishedStates.filter((state) => state.notify).length,
      1,
      'one staged preview update generated multiple notifications',
    );

    // Equal sender/message text must retain a body instead of degrading into
    // sound-only behavior.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Alice'`);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.body === 'Alice'),
      'message equal to conversation title lost its toast body',
    );

    // Calendar-looking words are timestamps only in the row's trailing status
    // slot. They remain valid message bodies in the preview slot.
    for (const shortMessage of ['Ne', 'So', 'm', 'week']) {
      publishedStates.length = 0;
      await win.webContents.executeJavaScript(
        `document.querySelector('#preview-a').textContent = ${JSON.stringify(shortMessage)}`,
      );
      await waitFor(
        () => publishedStates.some((state) => state.notify
          && state.message?.body === shortMessage),
        `short message ${shortMessage} was mistaken for a timestamp`,
      );
    }

    // Reaction/control icons outside the preview are UI, even when their
    // accessible label is an emoji.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__reactionControl = document.createElement('button');
      window.__reactionControl.innerHTML = '<span role="img" aria-label="👍"></span>';
      document.querySelector('#row-a').appendChild(window.__reactionControl);
    `);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'reaction UI icon generated a message toast');
    await win.webContents.executeJavaScript(`window.__reactionControl.remove()`);

    // A reaction emoji can be nested directly inside the textual preview. The
    // icon must not resurrect a reaction row after its text was filtered.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#preview-a').innerHTML = 'Alice reagovala na vaši zprávu <span role="img" aria-label="👍"></span>';
    `);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'nested reaction emoji generated a message toast');
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'week'`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'restoring a preview after nested reaction generated a notification');

    // Some accessibility trees expose the reaction text and emoji as sibling
    // semantic leaves rather than nesting them in one preview wrapper.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#preview-a').textContent = 'Alice reagovala na vaši zprávu';
      window.__siblingReactionEmoji = document.createElement('span');
      window.__siblingReactionEmoji.setAttribute('dir', 'auto');
      window.__siblingReactionEmoji.innerHTML = '<span role="img" aria-label="👍"></span>';
      document.querySelector('#row-a').insertBefore(window.__siblingReactionEmoji, document.querySelector('#status-a'));
    `);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'sibling reaction emoji generated a message toast');
    await win.webContents.executeJavaScript(`
      window.__siblingReactionEmoji.remove();
      document.querySelector('#preview-a').textContent = 'week';
    `);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'restoring a preview after sibling reaction generated a notification');

    // Emoji-only previews expose their content through image accessibility
    // labels, not textContent.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').innerHTML = '<img alt="😄">'`);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.body === '😄'),
      'emoji-only incoming message was missed',
    );
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a img').outerHTML = '<img alt="🔥">'`);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.body === '🔥'),
      'second emoji-only incoming message was missed',
    );

    // An unrelated presence/receipt leaf elsewhere in the row must not
    // suppress an emoji-only preview in its own semantic container.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#status-a').textContent = 'Active now';
      document.querySelector('#preview-a img').outerHTML = '<img alt="🧡">';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.body === '🧡'),
      'emoji-only message beside an unrelated status was missed',
    );
    await win.webContents.executeJavaScript(`document.querySelector('#status-a').textContent = 'Před 1 min'`);

    // React/accessibility can mirror the same preview in a sibling leaf. The
    // body and its signature both deduplicate that mirror, so adding/removing
    // it cannot create a second toast for unchanged content.
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Duplicate baseline'`);
    await waitFor(
      () => publishedStates.some((state) => state.notify && state.message?.body === 'Duplicate baseline'),
      'duplicate-signature baseline message was missed',
    );
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__duplicatePreview = document.createElement('span');
      window.__duplicatePreview.setAttribute('dir', 'auto');
      window.__duplicatePreview.textContent = 'Duplicate baseline';
      document.querySelector('#row-a').insertBefore(window.__duplicatePreview, document.querySelector('#status-a'));
    `);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'duplicate accessibility preview generated a notification');
    await win.webContents.executeJavaScript(`window.__duplicatePreview.remove()`);
    await delay(300);
    assert.equal(publishedStates.some((state) => state.notify), false, 'removing duplicate accessibility preview generated a notification');

    // If Meta removes its usual dir=auto wrappers, a confirmed changed chat
    // preview still gets a safe generic app-authored toast.
    await win.webContents.executeJavaScript(`
      window.__genericRow = document.createElement('a');
      window.__genericRow.className = 'thread';
      window.__genericRow.href = 'https://www.facebook.com/messages/t/generic';
      window.__genericRow.innerHTML = '<span>Old opaque preview</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__genericRow);
    `);
    await delay(250);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__genericRow.setAttribute('data-unread', 'true');
      window.__genericRow.querySelector('span').textContent = 'Changed opaque preview';
      window.__genericRow.querySelector('button').setAttribute('aria-label', 'Mark as read');
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'generic'
        && state.message?.title === 'Messenger'
        && state.message?.body === 'Nová zpráva'),
      'generic metadata fallback toast was missed',
    );
    await win.webContents.executeJavaScript(`window.__genericRow.remove()`);

    // A real message can arrive as a complete React replacement instead of a
    // text mutation. Preserve the known row baseline through the hydration
    // quiet window and emit exactly one toast after it settles.
    await win.webContents.executeJavaScript(`
      window.__replacementRow = document.createElement('a');
      window.__replacementRow.className = 'thread';
      window.__replacementRow.href = 'https://www.facebook.com/messages/t/replacement-message';
      window.__replacementRow.innerHTML = '<img alt=""><span dir="auto">Renata</span><span dir="auto">Old preview</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__replacementRow);
    `);
    await delay(250);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      const messageReplacement = document.createElement('a');
      messageReplacement.className = 'thread';
      messageReplacement.href = 'https://www.facebook.com/messages/t/replacement-message';
      messageReplacement.setAttribute('data-unread', 'true');
      messageReplacement.innerHTML = '<img alt=""><span dir="auto">Renata</span><span dir="auto">Message delivered by replacement</span><button aria-label="Mark as read"></button>';
      window.__replacementRow.replaceWith(messageReplacement);
      window.__replacementRow = messageReplacement;
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'replacement-message'),
      'complete React row replacement lost a real message',
    );
    assert.equal(
      publishedStates.filter((state) => state.notify
        && state.message?.threadId === 'replacement-message').length,
      1,
      'React row replacement emitted duplicate toasts',
    );
    await win.webContents.executeJavaScript(`window.__replacementRow.remove()`);

    // A previously unseen row can also be old unread content inserted by lazy
    // loading or an inbox-view switch. Without a prior content baseline it is
    // deliberately counted but never treated as a new message.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__newTopRow = document.createElement('a');
      window.__newTopRow.className = 'thread';
      window.__newTopRow.href = 'https://www.facebook.com/messages/e2ee/t/new-top-message';
      window.__newTopRow.setAttribute('data-unread', 'true');
      window.__newTopRow.innerHTML = '<img alt=""><span dir="auto">Nový chat</span><span dir="auto">První zpráva</span><button aria-label="Mark as read"></button>';
      window.__newTopSibling = document.createElement('a');
      window.__newTopSibling.className = 'thread';
      window.__newTopSibling.href = 'https://www.facebook.com/messages/t/new-top-sibling';
      window.__newTopSibling.setAttribute('data-unread', 'true');
      window.__newTopSibling.innerHTML = '<img alt=""><span dir="auto">Starší chat</span><span dir="auto">Hydrated preview</span><button aria-label="Mark as read"></button>';
      const hydrationBatch = document.createDocumentFragment();
      hydrationBatch.append(window.__newTopRow, window.__newTopSibling);
      document.querySelector('#live-nav').insertBefore(
        hydrationBatch,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(1100);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'new-top-message'),
      false,
      'unknown top-row hydration generated a notification',
    );
    await win.webContents.executeJavaScript(`
      for (const row of [window.__newTopRow, window.__newTopSibling]) {
        row.setAttribute('data-unread', 'false');
        row.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      }
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`
      window.__newTopRow.remove();
      window.__newTopSibling.remove();
    `);

    // A single old row can hydrate slowly too. Without a contemporaneous
    // Messenger title-count increase, even a complete unread row at the top is
    // only a baseline and must remain silent.
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await delay(25);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__singleHydrationRow = document.createElement('a');
      window.__singleHydrationRow.className = 'thread';
      window.__singleHydrationRow.href = 'https://www.facebook.com/messages/t/single-hydration';
      window.__singleHydrationRow.setAttribute('data-unread', 'true');
      window.__singleHydrationRow.innerHTML = '<img alt=""><span dir="auto">Pomalu načtený chat</span><span dir="auto">Starý nepřečtený náhled</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__singleHydrationRow,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(2250);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'single-hydration'),
      false,
      'single old top-row hydration generated a notification',
    );
    await win.webContents.executeJavaScript(`
      window.__singleHydrationRow.setAttribute('data-unread', 'false');
      window.__singleHydrationRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__singleHydrationRow.remove()`);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // In a mature background list, one complete unread row inserted at the
    // top plus a contemporaneous title-count increase is the high-confidence
    // first-message shape for a new conversation.
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 4 });
    await delay(25);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__newMessageRow = document.createElement('a');
      window.__newMessageRow.className = 'thread';
      window.__newMessageRow.href = 'https://www.facebook.com/messages/e2ee/t/new-message-thread';
      window.__newMessageRow.setAttribute('data-unread', 'true');
      window.__newMessageRow.innerHTML = '<img alt=""><span dir="auto">Nová konverzace</span><span dir="auto">Opravdová první zpráva</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__newMessageRow,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'new-message-thread'),
      'single new background conversation message was missed',
    );
    assert.deepEqual(
      publishedStates.findLast((state) => state.message?.threadId === 'new-message-thread').message,
      {
        threadId: 'new-message-thread',
        encrypted: true,
        title: 'Nová konverzace',
        body: 'Opravdová první zpráva',
      },
    );
    await win.webContents.executeJavaScript(`
      window.__newMessageRow.setAttribute('data-unread', 'false');
      window.__newMessageRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__newMessageRow.remove()`);

    // The renderer mutation normally wins the race against the main-process
    // page-title roundtrip. Keep the provisional candidate alive so the later
    // genuine 4 -> 5 title increase can corroborate it too.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__newMessageRowAfterTitle = document.createElement('a');
      window.__newMessageRowAfterTitle.className = 'thread';
      window.__newMessageRowAfterTitle.href = 'https://www.facebook.com/messages/t/new-message-after-title';
      window.__newMessageRowAfterTitle.setAttribute('data-unread', 'true');
      window.__newMessageRowAfterTitle.innerHTML = '<img alt=""><span dir="auto">Pozdější title</span><span dir="auto">DOM přišel jako první</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__newMessageRowAfterTitle,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: true, count: 5 });
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'new-message-after-title'),
      'DOM-first new conversation was not corroborated by the later title increase',
    );
    await win.webContents.executeJavaScript(`
      window.__newMessageRowAfterTitle.setAttribute('data-unread', 'false');
      window.__newMessageRowAfterTitle.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__newMessageRowAfterTitle.remove()`);

    // One title increase is one corroboration token. If a real new row and a
    // stale hydration appear in separate observer batches, that single signal
    // must never promote both provisional candidates.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__tokenRowA = document.createElement('a');
      window.__tokenRowA.className = 'thread';
      window.__tokenRowA.href = 'https://www.facebook.com/messages/t/title-token-a';
      window.__tokenRowA.setAttribute('data-unread', 'true');
      window.__tokenRowA.innerHTML = '<span dir="auto">Token A</span><span dir="auto">První kandidát</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__tokenRowA,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`
      window.__tokenRowB = document.createElement('a');
      window.__tokenRowB.className = 'thread';
      window.__tokenRowB.href = 'https://www.facebook.com/messages/t/title-token-b';
      window.__tokenRowB.setAttribute('data-unread', 'true');
      window.__tokenRowB.innerHTML = '<span dir="auto">Token B</span><span dir="auto">Druhý kandidát</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__tokenRowB,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: true, count: 6 });
    await delay(2350);
    assert.deepEqual(
      publishedStates.filter((state) => state.notify
        && ['title-token-a', 'title-token-b'].includes(state.message?.threadId))
        .map((state) => state.message.threadId),
      ['title-token-b'],
      'one title increase was not reserved for the newest top-row candidate',
    );
    await win.webContents.executeJavaScript(`
      for (const row of [window.__tokenRowA, window.__tokenRowB]) {
        row.setAttribute('data-unread', 'false');
        row.querySelector('button').setAttribute('aria-label', 'Mark as unread');
        row.remove();
      }
    `);
    await delay(100);

    // A prior high title count must not suppress the next first unread after a
    // genuinely empty inbox. DOM zero plus an unavailable title establishes
    // the new zero baseline; a later 0 -> 1 increase can corroborate DOM-first.
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'false');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__postZeroMessage = document.createElement('a');
      window.__postZeroMessage.className = 'thread';
      window.__postZeroMessage.href = 'https://www.facebook.com/messages/t/post-zero-message';
      window.__postZeroMessage.setAttribute('data-unread', 'true');
      window.__postZeroMessage.innerHTML = '<span dir="auto">Po nule</span><span dir="auto">První nová nepřečtená</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__postZeroMessage,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'post-zero-message'),
      'first new conversation after a real zero state was missed',
    );
    await win.webContents.executeJavaScript(`
      window.__postZeroMessage.setAttribute('data-unread', 'false');
      window.__postZeroMessage.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__postZeroMessage.remove();
      document.querySelector('#row-a').setAttribute('data-unread', 'true');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as read');
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // A title increase caused by a real message in a known row belongs to that
    // DOM event, not to some provisional stale row that happened to be waiting
    // at the top. This prevents a duplicate known+hydration toast pair.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__crossSourceHydration = document.createElement('a');
      window.__crossSourceHydration.className = 'thread';
      window.__crossSourceHydration.href = 'https://www.facebook.com/messages/t/cross-source-hydration';
      window.__crossSourceHydration.setAttribute('data-unread', 'true');
      window.__crossSourceHydration.innerHTML = '<span dir="auto">Starý lazy chat</span><span dir="auto">Starý náhled</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__crossSourceHydration,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Známý chat dostal zprávu';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Známý chat dostal zprávu'),
      'known-row setup message was missed',
    );
    win.webContents.send('title-unread-hint', { available: true, count: 2 });
    await delay(2250);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'cross-source-hydration'),
      false,
      'known-row title increase was reused by a stale unknown row',
    );
    await win.webContents.executeJavaScript(`
      window.__crossSourceHydration.setAttribute('data-unread', 'false');
      window.__crossSourceHydration.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__crossSourceHydration.remove();
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // Cover the inverse renderer ordering too: title first, then the known
    // read->unread DOM commit. The stronger known transition can revoke the
    // stale unknown association throughout the full correlation window.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__titleFirstHydration = document.createElement('a');
      window.__titleFirstHydration.className = 'thread';
      window.__titleFirstHydration.href = 'https://www.facebook.com/messages/t/title-first-hydration';
      window.__titleFirstHydration.setAttribute('data-unread', 'true');
      window.__titleFirstHydration.innerHTML = '<span dir="auto">Title-first lazy</span><span dir="auto">Starý obsah</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__titleFirstHydration,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await delay(300);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Title-first známá zpráva';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Title-first známá zpráva'),
      'title-first known-row message was missed',
    );
    await delay(2250);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'title-first-hydration'),
      false,
      'title-first known-row increase was reused by a stale unknown row',
    );
    await win.webContents.executeJavaScript(`
      window.__titleFirstHydration.setAttribute('data-unread', 'false');
      window.__titleFirstHydration.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__titleFirstHydration.remove();
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // Corroboration can arrive just before an unknown row's original two-second
    // settle deadline. Settlement must extend from the title signal itself so
    // a slightly later known DOM transition can still claim that generation.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__lateTitleHydration = document.createElement('a');
      window.__lateTitleHydration.className = 'thread';
      window.__lateTitleHydration.href = 'https://www.facebook.com/messages/t/late-title-hydration';
      window.__lateTitleHydration.setAttribute('data-unread', 'true');
      window.__lateTitleHydration.innerHTML = '<span dir="auto">Late-title lazy</span><span dir="auto">Starý obsah na hraně</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__lateTitleHydration,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(1750);
    win.webContents.send('title-unread-hint', { available: true, count: 4 });
    await delay(300);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Známá zpráva po pozdním title';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Známá zpráva po pozdním title'),
      'known message after late title corroboration was missed',
    );
    await delay(2300);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'late-title-hydration'),
      false,
      'late title corroboration escaped before its known DOM owner arrived',
    );
    await win.webContents.executeJavaScript(`
      window.__lateTitleHydration.setAttribute('data-unread', 'false');
      window.__lateTitleHydration.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__lateTitleHydration.remove();
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // Separate G1/G2 generations preserve two genuine events in one burst:
    // an unknown conversation followed by a known read->unread transition.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__burstUnknown = document.createElement('a');
      window.__burstUnknown.className = 'thread';
      window.__burstUnknown.href = 'https://www.facebook.com/messages/t/burst-unknown';
      window.__burstUnknown.setAttribute('data-unread', 'true');
      window.__burstUnknown.innerHTML = '<span dir="auto">Burst nový chat</span><span dir="auto">První burst zpráva</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').insertBefore(
        window.__burstUnknown,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: true, count: 5 });
    await delay(300);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Druhá burst zpráva';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'b'
        && state.message?.body === 'Druhá burst zpráva'),
      'known half of a two-message burst was missed',
    );
    win.webContents.send('title-unread-hint', { available: true, count: 6 });
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'burst-unknown'),
      'unknown half of a two-message burst was lost by later generation consumption',
    );
    assert.deepEqual(
      publishedStates.filter((state) => state.notify
        && ['b', 'burst-unknown'].includes(state.message?.threadId))
        .map((state) => state.message.threadId)
        .sort(),
      ['b', 'burst-unknown'],
    );
    await win.webContents.executeJavaScript(`
      window.__burstUnknown.setAttribute('data-unread', 'false');
      window.__burstUnknown.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__burstUnknown.remove();
      document.querySelector('#row-b').setAttribute('data-unread', 'false');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Seen';
    `);
    await delay(100);
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(25);

    // A known read conversation may be virtualized away, receive a message,
    // and return at the top already unread. Its retained read baseline makes
    // that transition safe to notify after the replacement settles.
    await win.webContents.executeJavaScript(`
      window.__virtualizedReadRow = document.createElement('a');
      window.__virtualizedReadRow.className = 'thread';
      window.__virtualizedReadRow.href = 'https://www.facebook.com/messages/t/virtualized-read';
      window.__virtualizedReadRow.innerHTML = '<img alt=""><span dir="auto">Viktorie</span><span dir="auto">Starý náhled</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__virtualizedReadRow);
    `);
    await delay(300);
    await win.webContents.executeJavaScript(`window.__virtualizedReadRow.remove()`);
    await delay(1100);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__virtualizedReadRow.setAttribute('data-unread', 'true');
      window.__virtualizedReadRow.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__virtualizedReadRow.querySelectorAll('[dir="auto"]')[1].textContent = 'Zpráva přijatá mimo viewport';
      document.querySelector('#live-nav').insertBefore(
        window.__virtualizedReadRow,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'virtualized-read'
        && state.message?.body === 'Zpráva přijatá mimo viewport'),
      'message received while a known read row was virtualized was missed',
    );
    await win.webContents.executeJavaScript(`
      window.__virtualizedReadRow.setAttribute('data-unread', 'false');
      window.__virtualizedReadRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__virtualizedReadRow.remove()`);

    // The same offscreen path also applies when the retained conversation was
    // already unread. It is eligible only when it returns alone at the top and
    // its first complete preview already differs from the retained baseline.
    await win.webContents.executeJavaScript(`
      window.__virtualizedUnreadRow = document.createElement('a');
      window.__virtualizedUnreadRow.className = 'thread';
      window.__virtualizedUnreadRow.href = 'https://www.facebook.com/messages/t/virtualized-unread';
      window.__virtualizedUnreadRow.setAttribute('data-unread', 'true');
      window.__virtualizedUnreadRow.innerHTML = '<img alt=""><span dir="auto">Uršula</span><span dir="auto">První nepřečtená zpráva</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(window.__virtualizedUnreadRow);
    `);
    await delay(300);
    await win.webContents.executeJavaScript(`window.__virtualizedUnreadRow.remove()`);
    await delay(1100);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__virtualizedUnreadRow.querySelectorAll('[dir="auto"]')[1].textContent = 'Druhá zpráva mimo viewport';
      document.querySelector('#live-nav').insertBefore(
        window.__virtualizedUnreadRow,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
    `);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'virtualized-unread'
        && state.message?.body === 'Druhá zpráva mimo viewport'),
      'second message received while an unread row was virtualized was missed',
    );
    await win.webContents.executeJavaScript(`
      window.__virtualizedUnreadRow.setAttribute('data-unread', 'false');
      window.__virtualizedUnreadRow.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__virtualizedUnreadRow.remove()`);

    // If the same unread row first returns with its retained preview and only
    // then hydrates different text, that change is part of the remount. The
    // first-observed baseline keeps it silent even at the top of the list.
    await win.webContents.executeJavaScript(`
      window.__virtualizedUnreadHydration = document.createElement('a');
      window.__virtualizedUnreadHydration.className = 'thread';
      window.__virtualizedUnreadHydration.href = 'https://www.facebook.com/messages/t/virtualized-unread-hydration';
      window.__virtualizedUnreadHydration.setAttribute('data-unread', 'true');
      window.__virtualizedUnreadHydration.innerHTML = '<img alt=""><span dir="auto">Hana</span><span dir="auto">Retained unread preview</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(window.__virtualizedUnreadHydration);
    `);
    await delay(300);
    await win.webContents.executeJavaScript(`window.__virtualizedUnreadHydration.remove()`);
    await delay(1100);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('#live-nav').insertBefore(
        window.__virtualizedUnreadHydration,
        document.querySelector('#live-nav a[href*="/messages/"]'),
      );
      setTimeout(() => {
        window.__virtualizedUnreadHydration.querySelectorAll('[dir="auto"]')[1].textContent = 'Delayed unread hydration';
        resolve(true);
      }, 100);
    })`);
    await delay(1100);
    assert.equal(
      publishedStates.some((state) => state.notify
        && state.message?.threadId === 'virtualized-unread-hydration'),
      false,
      'delayed hydration of a returning unread row generated a notification',
    );
    await win.webContents.executeJavaScript(`
      window.__virtualizedUnreadHydration.setAttribute('data-unread', 'false');
      window.__virtualizedUnreadHydration.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      window.__virtualizedUnreadHydration.remove();
    `);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__rowC = document.createElement('a');
      window.__rowC.id = 'row-c';
      window.__rowC.className = 'thread';
      window.__rowC.href = 'https://www.facebook.com/messages/t/c';
      window.__rowC.setAttribute('data-unread', 'true');
      window.__rowC.innerHTML = '<img alt=""><span dir="auto">Carol</span><span dir="auto">First sight</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(window.__rowC);
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 2), 'new virtualized row was not counted');
    assert.equal(publishedStates.findLast((state) => state.count === 2).notify, false);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`window.__rowC.remove()`);
    await delay(250);
    assert.equal(publishedStates.length, 0, 'virtualization removal changed the canonical state');
    await win.webContents.executeJavaScript(`document.querySelector('#live-nav').appendChild(window.__rowC)`);
    await delay(1100);
    assert.equal(publishedStates.length, 0, 'virtualization reinsertion generated a false notification');

    // React can replace a known row within one observer batch, so there is no
    // intermediate "missing" flush. Its delayed skeleton hydration must still
    // be quiet, while a later real preview change remains eligible.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const replacement = document.createElement('a');
      replacement.id = 'row-c';
      replacement.className = 'thread';
      replacement.href = 'https://www.facebook.com/messages/t/c';
      replacement.setAttribute('data-unread', 'true');
      replacement.innerHTML = '<img alt=""><span dir="auto">Carol</span><span dir="auto"></span><button aria-label="Mark as read"></button>';
      window.__rowC.replaceWith(replacement);
      window.__rowC = replacement;
      setTimeout(() => {
        replacement.querySelectorAll('[dir="auto"]')[1].textContent = 'Delayed replacement hydration';
        resolve(true);
      }, 50);
    })`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'same-batch row replacement hydration generated a notification');
    await delay(550);
    await win.webContents.executeJavaScript(`
      window.__rowC.querySelectorAll('[dir="auto"]')[1].textContent = 'Real message after replacement quiet period';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === 2 && state.notify),
      'real message after same-batch replacement was suppressed',
    );

    // A permanently removed unread thread must stop contributing to the DOM
    // fallback after a grace period, while retaining enough identity to make a
    // much later virtualized reappearance and delayed hydration silent.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__rowD = document.createElement('a');
      window.__rowD.id = 'row-d';
      window.__rowD.className = 'thread';
      window.__rowD.href = 'https://www.facebook.com/messages/t/d';
      window.__rowD.setAttribute('data-unread', 'true');
      window.__rowD.innerHTML = '<img alt=""><span dir="auto">Dana</span><span dir="auto">Archived preview</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(window.__rowD);
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'permanent-removal setup missing');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, false);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`window.__rowD.remove()`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'missing thread decremented before the virtualization grace');
    await waitFor(
      () => publishedStates.some((state) => state.count === 2),
      'permanently removed unread thread remained in the fallback count',
    );
    assert.deepEqual(
      publishedStates.filter((state) => state.count === 2),
      [{ count: 2, notify: false, hasBadge: true }],
    );

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#live-nav').appendChild(window.__rowD)`);
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'expired thread did not rejoin the count');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, false);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__rowD.querySelectorAll('[dir="auto"]')[1].textContent = 'Delayed virtualized hydration';
    `);
    await delay(850);
    assert.equal(publishedStates.length, 0, 'delayed virtualized hydration generated a false notification');
    await win.webContents.executeJavaScript(`
      window.__rowD.querySelectorAll('[dir="auto"]')[1].textContent = 'Real message after quiet period';
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === 3 && state.notify),
      'real message after virtualized hydration was suppressed',
    );

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      window.__rowD.setAttribute('data-unread', 'false');
      window.__rowD.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 2), 'reappeared thread read transition missing');
    assert.equal(publishedStates.findLast((state) => state.count === 2).notify, false);
    await win.webContents.executeJavaScript(`window.__rowD.remove()`);

    // A list reorder can detach and reinsert a real new-message row inside the
    // 180 ms stability window. Suspend the candidate across that short gap.
    await win.webContents.executeJavaScript(`
      window.__pendingReorder = document.createElement('a');
      window.__pendingReorder.className = 'thread';
      window.__pendingReorder.href = 'https://www.facebook.com/messages/t/pending-reorder';
      window.__pendingReorder.innerHTML = '<img alt=""><span dir="auto">Pending reorder</span><span dir="auto">Read</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__pendingReorder);
    `);
    await delay(100);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      window.__pendingReorder.setAttribute('data-unread', 'true');
      window.__pendingReorder.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__pendingReorder.querySelectorAll('[dir="auto"]')[1].textContent = 'Message survives reorder';
      setTimeout(() => {
        window.__pendingReorder.remove();
        setTimeout(() => {
          document.querySelector('#live-nav').appendChild(window.__pendingReorder);
          resolve(true);
        }, 40);
      }, 40);
    })`);
    await waitFor(
      () => publishedStates.some((state) => state.notify
        && state.message?.threadId === 'pending-reorder'),
      'real message was lost during a short row reorder',
    );
    await win.webContents.executeJavaScript(`
      window.__pendingReorder.setAttribute('data-unread', 'false');
      window.__pendingReorder.querySelector('button').setAttribute('aria-label', 'Mark as unread');
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`window.__pendingReorder.remove()`);

    // Removing a row while its stable-notification timer is pending must
    // remain silent if the row never returns, while retaining the count until
    // the same virtualization grace expires.
    await win.webContents.executeJavaScript(`
      window.__pendingRemoval = document.createElement('a');
      window.__pendingRemoval.className = 'thread';
      window.__pendingRemoval.href = 'https://www.facebook.com/messages/t/pending-removal';
      window.__pendingRemoval.innerHTML = '<img alt=""><span dir="auto">Pending removal</span><span dir="auto">Read</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(window.__pendingRemoval);
    `);
    await delay(100);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      window.__pendingRemoval.setAttribute('data-unread', 'true');
      window.__pendingRemoval.querySelector('button').setAttribute('aria-label', 'Mark as read');
      window.__pendingRemoval.querySelectorAll('[dir="auto"]')[1].textContent = 'Pending message';
      setTimeout(() => {
        window.__pendingRemoval.remove();
        resolve(true);
      }, 50);
    })`);
    await delay(250);
    assert.ok(
      publishedStates.some((state) => state.count === 3 && !state.notify),
      'pending-removal transition missing',
    );
    assert.equal(
      publishedStates.some((state) => state.notify),
      false,
      'removed row emitted its pending notification',
    );
    assert.equal(
      publishedStates.some((state) => state.count === 2),
      false,
      'removed pending row decremented before the virtualization grace',
    );
    await waitFor(
      () => publishedStates.some((state) => state.count === 2 && !state.notify),
      'removed pending row did not retire silently',
    );

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      const duplicate = window.__rowC.cloneNode(true);
      duplicate.id = 'row-c-duplicate';
      duplicate.setAttribute('data-unread', 'false');
      duplicate.querySelector('button').setAttribute('aria-label', 'Mark as unread');
      document.querySelector('#live-nav').appendChild(duplicate);
    `);
    await delay(150);
    assert.equal(publishedStates.length, 0, 'duplicate thread rows were double-counted');

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-c').style.display = 'none';
      document.querySelector('#row-c-duplicate').style.display = 'flex';
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'visible duplicate switch was not reconciled');
    assert.equal(publishedStates.findLast((state) => state.count === 1).notify, false);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-c').style.display = 'flex';
      document.querySelector('#row-c-duplicate').style.display = 'none';
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 2), 'visible duplicate switch-back was not reconciled');
    assert.equal(publishedStates.findLast((state) => state.count === 2).notify, false);

    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').href = 'https://www.facebook.com/messages/t/reused';
      document.querySelector('#row-b').setAttribute('data-unread', 'true');
      document.querySelector('#row-b button').setAttribute('aria-label', 'Mark as read');
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'href reuse was not reconciled');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, false);

    // A virtualized row can be recycled back to an identity already retained
    // in state. The accompanying preview rewrite is hydration, not a message.
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      const recycled = document.querySelector('#row-b');
      recycled.removeAttribute('href');
    `);
    await delay(50);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').href = 'https://www.facebook.com/messages/t/c';
    `);
    await delay(400);
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-b').querySelectorAll('[dir="auto"]')[1].textContent = 'Delayed recycled preview';
    `);
    await delay(300);
    assert.equal(
      publishedStates.filter((state) => state.notify).length,
      0,
      'returning href reuse generated a false notification',
    );

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      const pendingRow = document.createElement('a');
      pendingRow.id = 'pending-row';
      pendingRow.className = 'thread';
      pendingRow.href = 'https://www.facebook.com/messages/t/pending-a';
      pendingRow.innerHTML = '<img alt=""><span dir="auto">Pending</span><span dir="auto">Read</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#live-nav').appendChild(pendingRow);
    `);
    await delay(100);
    await win.webContents.executeJavaScript(`
      const rowToRecycle = document.querySelector('#pending-row');
      rowToRecycle.setAttribute('data-unread', 'true');
      rowToRecycle.querySelector('button').setAttribute('aria-label', 'Mark as read');
      rowToRecycle.querySelectorAll('[dir="auto"]')[1].textContent = 'Will be recycled';
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 4), 'pending notification setup failed');
    await win.webContents.executeJavaScript(`
      document.querySelector('#pending-row').removeAttribute('href');
    `);
    await delay(50);
    await win.webContents.executeJavaScript(`
      document.querySelector('#pending-row').href = 'https://www.facebook.com/messages/t/pending-b';
    `);
    await delay(300);
    assert.equal(
      publishedStates.filter((state) => state.notify).length,
      0,
      'href reuse allowed a stale pending notification to fire',
    );

    await win.webContents.executeJavaScript(`
      window.__oldMain = document.querySelector('#main');
      const replacement = document.createElement('main');
      replacement.id = 'main-2';
      replacement.setAttribute('role', 'main');
      replacement.innerHTML = '<section id="region-2" role="region"><div class="messages">Replacement</div><div class="composer"><div role="textbox" contenteditable="true"></div></div></section>';
      window.__oldMain.replaceWith(replacement);
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#region-2')?.hasAttribute('data-messenger-app-thread-fill')
      && !window.__oldMain.querySelector('[data-messenger-app-thread-fill]')
      && document.querySelectorAll('[data-messenger-app-resize-handle]').length === 1
    `), 'main replacement did not reconcile cleanly');

    const liveCountBeforeCleanup = publishedStates.findLast(
      (state) => Number.isSafeInteger(state.count),
    )?.count;
    assert.ok(Number.isSafeInteger(liveCountBeforeCleanup), 'live count unavailable before cleanup race test');
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      const cleanupRow = document.createElement('a');
      cleanupRow.id = 'cleanup-row';
      cleanupRow.className = 'thread';
      cleanupRow.href = 'https://www.facebook.com/messages/t/cleanup';
      cleanupRow.setAttribute('data-unread', 'true');
      cleanupRow.innerHTML = '<img alt=""><span dir="auto">Cleanup</span><span dir="auto">Pending retirement</span><button aria-label="Mark as read"></button>';
      document.querySelector('#live-nav').appendChild(cleanupRow);
    `);
    await waitFor(
      () => publishedStates.some((state) => state.count === liveCountBeforeCleanup + 1),
      'cleanup race setup missing',
    );
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#cleanup-row').remove()`);
    await delay(100);
    assert.equal(publishedStates.length, 0, 'cleanup race decremented before its grace');

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#live-nav').style.display = 'none';
      document.querySelector('#cached-nav').style.display = 'block';
    `);
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.querySelector('[data-messenger-app-nav]')?.id === 'cached-nav'`,
    ), 'visible nav cache was not selected');
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'new nav baseline missing');
    assert.equal(publishedStates.findLast((state) => state.count === 0).notify, false);
    publishedStates.length = 0;
    await delay(1100);
    assert.equal(publishedStates.length, 0, 'disposed tracker published its missing-thread expiry');

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'false');
      document.querySelector('#preview-a').textContent = 'Detached mutation';
    `);
    await delay(150);
    assert.equal(publishedStates.length, 0, 'inactive nav kept publishing mutations');

    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'title fallback baseline missing');
    assert.equal(publishedStates.findLast((state) => state.count === 1).notify, false);

    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'title zero transition missing');
    assert.equal(publishedStates.findLast((state) => state.count === 0).notify, false);

    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await waitFor(() => publishedStates.some((state) => state.count === 1), 'title availability recovery missing');
    assert.equal(publishedStates.findLast((state) => state.count === 1).notify, false);

    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 2 });
    await waitFor(() => publishedStates.some((state) => state.count === 2), 'post-baseline title update missing');
    assert.equal(publishedStates.findLast((state) => state.count === 2).notify, false);
    assert.equal(publishedStates.some((state) => state.message), false);

    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(20);
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'brief title flap lost a real count increase');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, false);
    assert.equal(publishedStates.some((state) => state.message), false);

    await win.webContents.executeJavaScript(`
      document.querySelector('#live-nav')?.remove();
      document.querySelector('#cached-nav')?.remove();
      const lateNav = document.createElement('nav');
      lateNav.id = 'late-nav';
      lateNav.setAttribute('role', 'navigation');
      document.querySelector('#app').prepend(lateNav);
    `);
    await waitFor(async () => win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-messenger-app-nav]').length === 0`,
    ), 'old nav did not unmount');
    await win.webContents.executeJavaScript(`
      const link = document.createElement('a');
      link.id = 'late-row';
      link.className = 'thread';
      link.href = 'https://www.facebook.com/messages/t/late';
      link.innerHTML = '<img alt=""><span dir="auto">Late</span><span dir="auto">Mounted</span><button aria-label="Mark as unread"></button>';
      document.querySelector('#late-nav').appendChild(link);
    `);
    await waitFor(async () => win.webContents.executeJavaScript(`
      document.querySelector('#late-nav')?.hasAttribute('data-messenger-app-nav')
      && document.querySelectorAll('[data-messenger-app-resize-handle]').length === 1
    `), 'empty fallback nav was not discovered after its first thread link arrived');

    // Keep the title source out of this tracker-only boundary test.
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await waitFor(() => publishedStates.some((state) => state.count === 0), 'late nav DOM fallback missing');
    await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('#late-nav');
      const fragment = document.createDocumentFragment();
      for (let index = 1; index <= 499; index += 1) {
        const row = document.createElement('a');
        row.id = 'lru-row-' + index;
        row.className = 'thread';
        row.href = 'https://www.facebook.com/messages/t/lru-' + index;
        row.innerHTML = '<img alt=""><span dir="auto">LRU ' + index + '</span><span dir="auto">Read baseline</span><button aria-label="Mark as unread"></button>';
        fragment.appendChild(row);
      }
      nav.appendChild(fragment);
    })()`);
    await waitFor(async () => win.webContents.executeJavaScript(
      `Boolean(document.querySelector('#lru-row-499 [data-messenger-app-compact-text]'))`,
    ), '500-thread LRU baseline did not settle', 8000);

    await delay(1050);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('#late-nav');
      const overflowRow = document.createElement('a');
      overflowRow.id = 'lru-overflow';
      overflowRow.className = 'thread';
      overflowRow.href = 'https://www.facebook.com/messages/t/lru-overflow';
      overflowRow.innerHTML = '<img alt=""><span dir="auto">Overflow</span><span dir="auto">Read baseline</span><button aria-label="Mark as unread"></button>';
      nav.appendChild(overflowRow);

      const oldest = document.querySelector('#late-row');
      oldest.setAttribute('data-unread', 'true');
      oldest.querySelector('button').setAttribute('aria-label', 'Mark as read');
      oldest.querySelectorAll('[dir="auto"]')[1].textContent = 'Oldest became unread';
    })()`);
    await waitFor(
      () => publishedStates.some((state) => state.count === 1 && state.notify),
      'mid-batch LRU eviction dropped the oldest read-to-unread notification',
      8000,
    );

    console.log('DOM smoke passed: layout recovery, remounts, message-only notifications, LRU boundaries, virtualization, and title badge fallback.');
  } finally {
    if (focusSink && !focusSink.isDestroyed()) focusSink.destroy();
    if (!win.isDestroyed()) win.destroy();
  }
}

run().then(() => {
  scheduleProfileCleanup();
  app.exit(0);
}).catch((error) => {
  console.error(error.stack || error);
  scheduleProfileCleanup();
  app.exit(1);
});
