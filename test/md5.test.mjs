import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5, md5md5 } from '../src/lib/md5.js';

const ref = (s) => createHash('md5').update(s).digest('hex');

test('md5 与 node:crypto 一致（含边界长度/UTF-8/长输入）', () => {
  const samples = ['', 'a', 'abc', 'message digest', '中文测试🙂', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'y'.repeat(1000)];
  for (const s of samples) assert.equal(md5(s), ref(s), `len=${s.length}`);
  for (let i = 0; i < 200; i++) {
    const b = randomBytes(Math.floor(Math.random() * 300));
    assert.equal(md5(new Uint8Array(b)), createHash('md5').update(b).digest('hex'));
  }
});

test('md5md5 与用户现网订阅 token 一致', () => {
  assert.equal(md5md5('vp.example.org' + '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'), 'fa8a47f9c50e5aa620932c6e53fb3981');
});
