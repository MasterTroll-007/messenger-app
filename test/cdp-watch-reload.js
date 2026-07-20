'use strict';

const port = Number(process.argv[2] || 9223);

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.includes('facebook.com/messages'));
  if (!target) throw new Error('No Facebook Messages page target found.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      exceptions.push({
        text: details.text,
        description: details.exception?.description || null,
        url: details.url ? new URL(details.url).origin : null,
        line: details.lineNumber,
        column: details.columnNumber,
      });
      return;
    }
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

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const state = await call('Runtime.evaluate', {
    expression: `({
      activeNavCount: document.querySelectorAll('[data-messenger-app-nav]').length,
      handleCount: document.querySelectorAll('[data-messenger-app-resize-handle]').length,
      viewportRootCount: document.querySelectorAll('[data-messenger-app-viewport-root]').length,
      threadFillCount: document.querySelectorAll('[data-messenger-app-thread-fill]').length,
    })`,
    returnByValue: true,
  });
  console.log(JSON.stringify({ exceptions, state: state.result.value }, null, 2));
  socket.close();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
