'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('sandboxed preload requires only Electron built-ins', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const requiredModules = [...source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/gu)]
    .map((match) => match[2]);

  assert.deepEqual(requiredModules, ['electron']);
});
