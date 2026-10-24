import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import ipaddr from 'ipaddr.js';

export function createDnsCachedLookup(lookup = dns.lookup, { ttlMs = 5_000, maxEntries = 256 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(0, Number(ttlMs)) : 5_000;
  const limit = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.floor(Number(maxEntries))) : 256;

  return async (host, options) => {
    const key = String(host || '').toLowerCase().replace(/\\.$/, '');
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.records.map(record => ({ ...record }));
    }
    if (cached) cache.delete(key);

    const pending = inflight.get(key);
    if (pending) return (await pending).map(record => ({ ...record }));

    const task = Promise.resolve().then(() => lookup(host, options)).then(records => {
      if (Array.isArray(records) && records.length && ttl > 0) {
        const time = Date.now();
        for (const [entry, item] of cache) {
          if (item.expiresAt <= time) cache.delete(entry);
        }
        while (cache.size >= limit) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        cache.set(key, { records: records.map(record => ({ ...record })), expiresAt: time + ttl });
      }
      return records;
    });
    inflight.set(key, task);
    try {
      return (await task).map(record => ({ ...record }));
    } finally {
      if (inflight.get(key) === task) inflight.delete(key);
    }
  };
}


export function isPublicIp(input) {
  try {
    let address = ipaddr.parse(input);
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    return address.range() === 'unicast';
  } catch {
    return false;
  }
}

export function hostShapeAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
      h.endsWith('.home.arpa') || h === 'metadata' || h === 'metadata.google.internal' || h === 'host.docker.internal' ||
      h === 'instance-data' || h === 'kubernetes.default.svc') return false;
  return true;
}

export async function validateUrl(raw, options = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('Enter a valid website address.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Only public HTTP and HTTPS websites can be opened.');
  }
  if (!hostShapeAllowed(url.hostname)) {
    throw new Error('Local and private network destinations are blocked.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error('Local and private network destinations are blocked.');
  } else {
    let records;
    try {
      const lookup = options.lookup || dns.lookup;
      records = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error('The website hostname could not be resolved. Check the address and try again.');
    }
    if (!records.length || records.some(record => !isPublicIp(record.address))) {
      throw new Error('This destination resolves to a private or non-public network address and was blocked.');
    }
  }

  return url.href;
}
