import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const DEFAULTS = {
  host: '',
  port: 22,
  username: '',
  privateKeyPath: '',
  useAgent: true,
};

export class SshConnectionStore {
  constructor({ runtimeStateDir }) {
    this.storePath = path.join(runtimeStateDir, 'ssh-connection.json');
  }

  async read() {
    try {
      const raw = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
      return sanitize(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULTS };
      throw error;
    }
  }

  async write(partial) {
    const next = sanitize({ ...(await this.read()), ...partial });
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  async clear() {
    await fs.rm(this.storePath, { force: true });
    return { ...DEFAULTS };
  }
}

export function sanitize(raw = {}) {
  const port = Number(raw.port);
  return {
    host: String(raw.host || '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    username: String(raw.username || '').trim(),
    privateKeyPath: String(raw.privateKeyPath || '').trim(),
    useAgent: raw.useAgent !== false,
  };
}

export function expandHome(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function publicConnection(config, {
  connected = false,
  ready = false,
  error = null,
  hasPassword = false,
} = {}) {
  return {
    ...sanitize(config),
    has_password: Boolean(hasPassword),
    connected: Boolean(connected),
    ready: Boolean(ready),
    error: error || null,
  };
}
