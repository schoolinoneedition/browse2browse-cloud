import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import ipaddr from 'ipaddr.js';

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

  const host = url.hostname.replace(/^\\[|\\]$/g, '');
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
