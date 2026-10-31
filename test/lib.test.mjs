import test from 'node:test';
import assert from 'node:assert/strict';
import { hash32, hashUnit, mulberry32, shuffle } from '../src/lib/rand.js';
import { detectIsp } from '../src/lib/isp.js';

test('mulberry32 同种子序列完全一致，不同种子不同', () => {
  const a = mulberry32('seed'), b = mulberry32('seed'), c = mulberry32('other');
  const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()], sc = [c(), c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const v of sa) assert.ok(v >= 0 && v < 1);
});

test('hashUnit 落在 (0,1) 且分布均匀', () => {
  const N = 100000, buckets = new Array(10).fill(0);
  for (let i = 0; i < N; i++) {
    const u = hashUnit('k' + i);
    assert.ok(u > 0 && u < 1);
    buckets[Math.floor(u * 10)]++;
  }
  for (const n of buckets) assert.ok(Math.abs(n - N / 10) < N / 10 * 0.05, `桶偏差过大: ${buckets}`);
});

test('hash32 稳定且对输入敏感', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});

test('shuffle 不修改入参且是排列', () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const copy = src.slice();
  const out = shuffle(src, mulberry32(1));
  assert.deepEqual(src, copy);
  assert.deepEqual(out.slice().sort(), copy);
  assert.deepEqual(shuffle(src, mulberry32(1)), out);
});

test('detectIsp：非 CN 一律 cf；CN 按名称/ASN 识别', () => {
  assert.equal(detectIsp({ country: 'US', asn: 4134 }), 'cf');
  assert.equal(detectIsp({ country: 'CN', asn: 4134 }), 'ct');
  assert.equal(detectIsp({ country: 'CN', asn: 4837 }), 'cu');
  assert.equal(detectIsp({ country: 'CN', asOrganization: 'China Mobile Communications Group' }), 'cmcc');
  assert.equal(detectIsp({ country: 'CN', asn: 1 }), 'cf');
  assert.equal(detectIsp(undefined), 'cf');
});
