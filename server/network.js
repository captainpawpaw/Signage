// Lets screens find the server without anyone typing an IP address:
//   - answers mDNS queries for <name>.local (and <hostname>.local) with this
//     PC's LAN addresses, which Windows 10+, macOS, iOS and Android resolve;
//   - lists every address the server is reachable at, so add-ons can try them all.
import os from 'node:os';
import makeMdns from 'multicast-dns';

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

export const mdnsName = () => `${(process.env.MDNS_NAME || 'signage').toLowerCase()}.local`;

export function candidateUrls({ publicUrl, port, secure }) {
  const proto = secure ? 'https' : 'http';
  const host = os.hostname().toLowerCase();
  const list = [
    publicUrl,
    `${proto}://${mdnsName()}:${port}`,
    `${proto}://${host}:${port}`,
    `${proto}://${host}.local:${port}`,
    ...lanAddresses().map((ip) => `${proto}://${ip}:${port}`),
  ];
  return [...new Set(list.filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
}

export function startMdns({ log = console.log } = {}) {
  const names = [mdnsName(), `${os.hostname().toLowerCase()}.local`];
  let mdns;
  try {
    mdns = makeMdns({ reuseAddr: true });
  } catch (err) {
    log(`[signage] mDNS disabled: ${err.message}`);
    return () => {};
  }
  mdns.on('query', (query) => {
    for (const q of query.questions) {
      if (!['A', 'ANY'].includes(q.type) || !names.includes(q.name.toLowerCase())) continue;
      const answers = lanAddresses().map((ip) => ({ name: q.name, type: 'A', ttl: 120, data: ip }));
      if (answers.length) mdns.respond({ answers });
    }
  });
  mdns.on('error', (err) => log(`[signage] mDNS: ${err.message}`));
  log(`[signage] announcing ${names.join(', ')} on the local network`);
  return () => mdns.destroy();
}
