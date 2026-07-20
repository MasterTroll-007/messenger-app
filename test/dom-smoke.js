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
  publishedStates.push({
    count: payload?.count,
    notify: payload?.notify,
    hasBadge: typeof payload?.badgeDataUrl === 'string',
  });
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
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

    // Let the one-shot startup gate expire, then complete a skeleton row. Its
    // first stable preview is still baseline hydration and must remain silent.
    win.webContents.send('title-unread-hint', { available: true, count: 0 });
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(1550);
    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Hello'`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'late startup row hydration generated a notification');

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

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`
      document.querySelector('#row-a').setAttribute('data-unread', 'true');
      document.querySelector('#read-a').setAttribute('aria-label', 'Mark as read');
      document.querySelector('#preview-a').textContent = 'New hello';
    `);
    await waitFor(() => publishedStates.some((state) => state.count === 1 && state.notify), 'read-to-unread notification missing');
    await win.webContents.executeJavaScript(`
      window.requestAnimationFrame = window.__messengerTestRequestAnimationFrame;
      delete window.__messengerTestRequestAnimationFrame;
    `);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Another hello'`);
    await waitFor(() => publishedStates.some((state) => state.count === 1 && state.notify), 'already-unread message signature change missing');

    // A title count increase and a different message in an already-unread DOM
    // row can legitimately arrive inside the cross-source dedup window. The
    // latter must not be mistaken for a duplicate of the title event.
    await delay(1050);
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 1 });
    await delay(50);
    assert.equal(publishedStates.some((state) => state.notify), false, 'first title value after an unavailable gap notified');
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 2 });
    await waitFor(() => publishedStates.some((state) => state.count === 2 && state.notify), 'title notification setup missing');
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Different message after title event'`);
    await waitFor(
      () => publishedStates.filter((state) => state.count === 2 && state.notify).length === 2,
      'distinct DOM message was swallowed by cross-source dedup',
    );
    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await waitFor(
      () => publishedStates.some((state) => state.count === 3 && state.notify),
      'cross-source-exempt DOM message suppressed a following title event',
    );
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(50);

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#status-a').textContent = 'Před 2 min'`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'volatile relative time generated a notification');

    publishedStates.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Alice is typing…'`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'prefixed typing status generated a notification');

    await win.webContents.executeJavaScript(`document.querySelector('#preview-a').textContent = 'Jan píše…'`);
    await delay(300);
    assert.equal(publishedStates.length, 0, 'localized prefixed typing status generated a notification');

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

    // Removing a row while its stable-notification timer is pending must
    // cancel the sound immediately, but retain the count until the same grace.
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
    assert.equal(publishedStates.findLast((state) => state.count === 2).notify, true);

    publishedStates.length = 0;
    win.webContents.send('title-unread-hint', { available: false, count: 0 });
    await delay(20);
    win.webContents.send('title-unread-hint', { available: true, count: 3 });
    await waitFor(() => publishedStates.some((state) => state.count === 3), 'brief title flap lost a real count increase');
    assert.equal(publishedStates.findLast((state) => state.count === 3).notify, true);

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

    console.log('DOM smoke passed: layout recovery, remounts, viewport clamp, cross-source notifications, LRU boundaries, virtualization, and title fallback.');
  } finally {
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
