'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROClient } = require('../lib/client');

test('0x0ADD is a fixed 24-byte packet and does not swallow the following frame', () => {
  const client = new ROClient({});
  client.sockTag = 'zone';
  const first = Buffer.alloc(24);
  first.writeUInt16LE(0x0add, 0);
  first.writeUInt16LE(13911, 2); // fixed packet payload, not a length field
  const second = Buffer.alloc(8);
  second.writeUInt16LE(0x00b0, 0);
  client.onData(Buffer.concat([first, second]));
  assert.equal(client.packetCounts?.[0x0add], 1);
  assert.equal(client.packetCounts?.[0x00b0], 1);
  assert.equal(client.half, null);
});
