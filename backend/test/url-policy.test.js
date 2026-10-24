import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnsCachedLookup, hostShapeAllowed, isPublicIp, validateUrl } from '../src/url-policy.js';

test('allows only public unicast IP addresses', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('10.0.0.1'), false);
  assert.equal(isPublicIp('169.254.169.254'), false);
  assert.equal(isPublicIp('::1'), false);
});

test('blocks local hostnames', () => {
  for (const host of ['localhost', 'printer.local', 'service.internal', 'metadata.google.internal']) {
    assert.equal(hostShapeAllowed(host), false, host);
  }
  assert.equal(hostShapeAllowed('example.com'), true);
});

test('rejects non-web protocols and credential-bearing URLs', async () => {
  await assert.rejects(validateUrl('file:///etc/passwd'), /Only public HTTP and HTTPS/);
  await assert.rejects(validateUrl('ftp://example.com'), /Only public HTTP and HTTPS/);
  await assert.rejects(validateUrl('https://person:password@example.com'), /Only public HTTP and HTTPS/);
});

test('blocks loopback, private, link-local, and local host targets', async () => {
  await assert.rejects(validateUrl('http://127.0.0.1'), /Local and private/);
  await assert.rejects(validateUrl('http://10.0.0.4'), /Local and private/);
  await assert.rejects(validateUrl('http://169.254.169.254'), /Local and private/);
  await assert.rejects(validateUrl('http://localhost'), /Local and private/);
});

test('normalizes a public HTTPS URL without requiring external DNS for IP literals', async () => {
  assert.equal(await validateUrl('https://8.8.8.8/path?q=ok#section'), 'https://8.8.8.8/path?q=ok#section');
});

test('normalizes trailing dots and blocks bracketed IPv6 loopback', async () => {
  assert.equal(hostShapeAllowed('localhost.'), false);
  await assert.rejects(validateUrl('http://[::1]/'), /Local and private/);
});

test('accepts a public bracketed IPv6 literal', async () => {
  assert.equal(
    await validateUrl('https://[2606:4700:4700::1111]/path'),
    'https://[2606:4700:4700::1111]/path'
  );
});

test('blocks a hostname if any DNS answer is non-public', async () => {
  await assert.rejects(
    validateUrl('https://example.test', { lookup: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] }),
    /private or non-public/
  );
});

test('short DNS cache coalesces repeated public subresource lookups', async () => {
  let calls = 0;
  const lookup = createDnsCachedLookup(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return [{ address: '93.184.216.34', family: 4 }];
  }, { ttlMs: 1_000, maxEntries: 4 });

  const [first, second] = await Promise.all([
    validateUrl('https://example.test/a.js', { lookup }),
    validateUrl('https://EXAMPLE.test/b.css', { lookup })
  ]);
  assert.equal(first, 'https://example.test/a.js');
  assert.equal(second, 'https://example.test/b.css');
  await validateUrl('https://example.test/logo.png', { lookup });
  assert.equal(calls, 1);
});

test('DNS cache never makes a private answer public', async () => {
  const lookup = createDnsCachedLookup(async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ], { ttlMs: 1_000 });
  await assert.rejects(
    validateUrl('https://mixed.example.test/asset.js', { lookup }),
    /private or non-public/
  );
  await assert.rejects(
    validateUrl('https://mixed.example.test/next.css', { lookup }),
    /private or non-public/
  );
});
