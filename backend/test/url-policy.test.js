import test from 'node:test';
import assert from 'node:assert/strict';
import { hostShapeAllowed, isPublicIp, validateUrl } from '../src/url-policy.js';

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
