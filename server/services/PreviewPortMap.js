import net from 'net';

/**
 * Normalize a list of container TCP ports for publishing.
 * Accepts numbers or numeric strings; drops invalid / duplicate values.
 */
export function normalizePublishPorts(ports, { max = 16 } = {}) {
  if (!Array.isArray(ports)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ports) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
    if (out.length >= max) break;
  }
  return out;
}

/** Allocate an ephemeral host TCP port bound to 127.0.0.1. */
export function allocateHostPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(err => {
        if (err) reject(err);
        else if (!port) reject(new Error('failed to allocate host port'));
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

export async function allocatePortBindings(containerPorts) {
  const ports = normalizePublishPorts(containerPorts);
  const portBindings = {};
  const exposedPorts = {};
  const portMap = {};
  for (const containerPort of ports) {
    const hostPort = await allocateHostPort();
    const key = `${containerPort}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }];
    portMap[containerPort] = hostPort;
  }
  return { portBindings, exposedPorts, portMap };
}

/**
 * Rewrite a container-advertised preview URL to a host-local mapped URL.
 * Returns null when the container port is not published.
 */
export function rewritePreviewUrl(rawUrl, portMap) {
  if (!rawUrl || !portMap || typeof portMap !== 'object') return null;
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const containerPort = url.port
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80);
  const hostPort = portMap[containerPort] ?? portMap[String(containerPort)];
  if (!hostPort) return null;
  const path = `${url.pathname || '/'}${url.search || ''}${url.hash || ''}`;
  return `http://127.0.0.1:${hostPort}${path || '/'}`;
}

export function extractPreviewUrlFromOutput(output) {
  const match = String(output || '').match(/MULTILAB_PREVIEW_URL=(https?:\/\/\S+)/);
  return match ? match[1] : null;
}

export function buildPreviewMeta(output, portMap = {}) {
  const advertised = extractPreviewUrlFromOutput(output);
  if (!advertised) return {};
  const previewUrl = rewritePreviewUrl(advertised, portMap);
  return {
    preview_advertised_url: advertised,
    preview_url: previewUrl || null,
    preview_port_map: { ...portMap },
  };
}

/** Read container→host port map from a Docker inspect result. */
export function portMapFromInspect(inspect) {
  const bindings = inspect?.HostConfig?.PortBindings || inspect?.NetworkSettings?.Ports || {};
  const map = {};
  for (const [key, arr] of Object.entries(bindings)) {
    const containerPort = Number(String(key).split('/')[0]);
    const hostPort = Number(arr?.[0]?.HostPort);
    if (Number.isInteger(containerPort) && Number.isInteger(hostPort) && hostPort > 0) {
      map[containerPort] = hostPort;
    }
  }
  return map;
}
