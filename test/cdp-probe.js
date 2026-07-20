'use strict';

const port = Number(process.argv[2] || 9223);

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => (
    candidate.type === 'page' && /^https:\/\/(?:www\.)?facebook\.com\/messages(?:\/|$)/.test(candidate.url)
  ));
  if (!target) throw new Error('No Facebook Messages page target found.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Could not connect to the DevTools target.'));
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const expression = `new Promise((resolve) => {
    const nav = document.querySelector('[data-messenger-app-nav]');
    const main = Array.from(document.querySelectorAll('[role="main"]')).find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && getComputedStyle(node).display !== 'none';
    });
    const root = document.querySelector('[data-messenger-app-viewport-root]');
    const editor = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'))
      .find((node) => node.getBoundingClientRect().width > 100);
    const relevantStyleNodes = [root, nav].filter(Boolean);
    let settledStyleMutations = 0;
    const observer = new MutationObserver((records) => { settledStyleMutations += records.length; });
    relevantStyleNodes.forEach((node) => observer.observe(node, { attributes: true, attributeFilter: ['style'] }));
    setTimeout(() => {
      observer.disconnect();
      // Meta may replace the entire nav/main shell during the settling window.
      // Re-query live nodes so the report never describes detached captures.
      const nav = document.querySelector('[data-messenger-app-nav]');
      const main = Array.from(document.querySelectorAll('[role="main"]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && getComputedStyle(node).display !== 'none';
      });
      const root = document.querySelector('[data-messenger-app-viewport-root]');
      const editor = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'))
        .find((node) => node.getBoundingClientRect().width > 100);
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const navRect = nav?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      const rootRect = root?.getBoundingClientRect();
      const threadRegion = editor?.closest('[data-messenger-app-thread-fill]');
      const anchors = nav ? Array.from(nav.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')) : [];
      const semanticUnread = anchors.filter((link) => Array.from(link.querySelectorAll('[aria-label]')).some((node) => {
        const label = (node.getAttribute('aria-label') || '').toLowerCase();
        return label.includes('mark as read') || label.includes('označit jako přečten');
      })).length;
      const rowSignals = anchors.map((link) => {
        let rowContainer = link;
        for (let node = link.parentElement; node && nav?.contains(node); node = node.parentElement) {
          const rect = node.getBoundingClientRect();
          if (rect.height >= 36 && rect.height <= 120 && rect.width >= (nav?.getBoundingClientRect().width || 0) * 0.7) {
            rowContainer = node;
          }
        }
        const descendants = [rowContainer, ...Array.from(rowContainer.querySelectorAll('*')).slice(0, 300)];
        const weights = descendants.map((node) => {
          const parsed = Number.parseInt(getComputedStyle(node).fontWeight, 10);
          return Number.isFinite(parsed) ? parsed : 0;
        });
        const labels = Array.from(rowContainer.querySelectorAll('[aria-label]'))
          .map((node) => (node.getAttribute('aria-label') || '').toLowerCase());
        const dotColors = [...new Set(descendants.flatMap((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 3 || rect.height < 3 || rect.width > 24 || rect.height > 24) return [];
          const computed = getComputedStyle(node);
          const colors = [computed.backgroundColor, computed.fill]
            .filter((color) => color && color !== 'none' && color !== 'rgba(0, 0, 0, 0)');
          return colors;
        }))].sort();
        return {
          maxWeight: weights.length ? Math.max(...weights) : 0,
          hasMarkRead: labels.some((label) => label.includes('mark as read') || label.includes('označit jako přečten')),
          hasMarkUnread: labels.some((label) => label.includes('mark as unread') || label.includes('označit jako nepřečten')),
          ariaCurrent: link.getAttribute('aria-current'),
          appUnread: link.hasAttribute('data-messenger-app-unread'),
          visible: link.getBoundingClientRect().width > 1 && link.getBoundingClientRect().height > 1,
          dotColors,
        };
      });
      const allThreadLinks = Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]'));
      const navigationCandidates = Array.from(document.querySelectorAll('[role="navigation"], [aria-label="Conversation list"], [aria-label="Chat list"], [aria-label="Seznam konverzací"]'))
        .map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return {
            role: candidate.getAttribute('role'),
            ariaLabel: candidate.getAttribute('aria-label'),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            display: getComputedStyle(candidate).display,
            ariaHiddenAncestor: Boolean(candidate.closest('[aria-hidden="true"]')),
            threadLinks: candidate.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]').length,
            appNav: candidate.hasAttribute('data-messenger-app-nav'),
          };
        });
      const describe = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          role: node.getAttribute?.('role'),
          ariaLabel: node.getAttribute?.('aria-label'),
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          display: getComputedStyle(node).display,
          position: getComputedStyle(node).position,
          containsNav: Boolean(nav && node.contains(nav)),
          containsMain: Boolean(main && node.contains(main)),
        };
      };
      resolve({
        urlAllowed: location.protocol === 'https:'
          && ['facebook.com', 'www.facebook.com'].includes(location.hostname)
          && (location.pathname === '/messages' || location.pathname.startsWith('/messages/')),
        viewportHeight,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        managedBodyClasses: Array.from(document.body.classList)
          .filter((name) => name.startsWith('messenger-app-')),
        documentOverflow: document.documentElement.scrollHeight - viewportHeight,
        activeNavCount: document.querySelectorAll('[data-messenger-app-nav]').length,
        visibleMainCount: Array.from(document.querySelectorAll('[role="main"]')).filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && getComputedStyle(node).display !== 'none';
        }).length,
        handleCount: document.querySelectorAll('[data-messenger-app-resize-handle]').length,
        hiddenGlobalBanners: Array.from(document.querySelectorAll('[data-messenger-app-global-banner]'))
          .filter((node) => getComputedStyle(node).display === 'none').length,
        viewportRootCount: document.querySelectorAll('[data-messenger-app-viewport-root]').length,
        rootTop: rootRect?.top ?? null,
        rootHeight: rootRect?.height ?? null,
        navWidth: navRect?.width ?? null,
        mainWidth: mainRect?.width ?? null,
        threadBottom: threadRegion?.getBoundingClientRect().bottom ?? null,
        threadFillCount: document.querySelectorAll('[data-messenger-app-thread-fill]').length,
        threadRowCount: anchors.length,
        appUnreadRows: nav?.querySelectorAll('[data-messenger-app-unread]').length ?? null,
        semanticUnreadRows: semanticUnread,
        allThreadLinks: allThreadLinks.length,
        visibleThreadLinks: allThreadLinks.filter((link) => {
          const rect = link.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < window.innerHeight;
        }).length,
        navigationCandidates,
        settledStyleMutations,
        rowSignalSummary: {
          maxWeightHistogram: rowSignals.reduce((result, row) => {
            result[row.maxWeight] = (result[row.maxWeight] || 0) + 1;
            return result;
          }, {}),
          markReadRows: rowSignals.filter((row) => row.hasMarkRead).length,
          markUnreadRows: rowSignals.filter((row) => row.hasMarkUnread).length,
          boldRows: rowSignals.filter((row) => row.maxWeight >= 600).length,
          visibleBoldRows: rowSignals.filter((row) => row.visible && row.maxWeight >= 600).length,
          currentRows: rowSignals.filter((row) => row.ariaCurrent).length,
          ariaCurrentHistogram: rowSignals.reduce((result, row) => {
            const value = String(row.ariaCurrent);
            result[value] = (result[value] || 0) + 1;
            return result;
          }, {}),
          dotColorRowHistogram: rowSignals.reduce((result, row) => {
            const value = row.dotColors.join('|') || 'none';
            result[value] = (result[value] || 0) + 1;
            return result;
          }, {}),
        },
        roleBanners: Array.from(document.querySelectorAll('[role="banner"]')).map(describe),
        topStack: document.elementsFromPoint(Math.max(1, window.innerWidth / 2), 10).slice(0, 8).map(describe),
        rootAncestors: (() => {
          const result = [];
          for (let node = root; node && result.length < 8; node = node.parentElement) result.push(describe(node));
          return result;
        })(),
      });
    }, 500);
  })`;

  const evaluation = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description || 'Runtime evaluation failed.');
  }
  console.log(JSON.stringify(evaluation.result.value, null, 2));
  socket.close();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
