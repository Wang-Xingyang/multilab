import ssh2 from 'ssh2';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';
import { describeCapabilities, describeProbe } from './RuntimeContract.js';
import { describeCopyStrategy } from '../workspace/WorkspaceStrategy.js';
import { validateWorkspaceRelPath } from '../services/PackageService.js';
import {
  CANONICAL_WORKSPACE,
  localRcFileContents,
  rewriteCanonicalWorkspace,
} from './localShellEnv.js';
import { expandHome, publicConnection, sanitize } from '../services/SshConnectionStore.js';
import { defaultSshAgent } from '../platform.js';

const { Client } = ssh2;
const DEFAULT_IDENTITIES = ['id_ed25519', 'id_rsa', 'id_ecdsa'];

export class SshRuntimeProvider extends RuntimeProvider {
  constructor({
    workspaceDir = CANONICAL_WORKSPACE,
    connectionStore = null,
  } = {}) {
    super({ id: 'ssh', kind: 'ssh' });
    this.workspaceDir = workspaceDir;
    this.connectionStore = connectionStore;
    this.savedConnection = sanitize();
    this.password = null;
    this.session = new SshRuntimeSession({ provider: this, logicalWorkspace: workspaceDir });
  }

  async loadSavedConnection() {
    if (!this.connectionStore) return this.savedConnection;
    this.savedConnection = await this.connectionStore.read();
    this.session.connection = this.savedConnection;
    this.session.password = this.password;
    return this.savedConnection;
  }

  describeConnection() {
    return publicConnection(this.savedConnection, {
      connected: Boolean(this.session?.client),
      ready: Boolean(this.session?.ready),
      error: this.session?.lastError || null,
      hasPassword: Boolean(this.password),
    });
  }

  async applyConnection(partial = {}) {
    const next = sanitize({ ...this.savedConnection, ...partial });
    if (Object.prototype.hasOwnProperty.call(partial, 'password')) {
      this.password = String(partial.password || '') || null;
    }
    this.savedConnection = next;
    if (this.connectionStore) await this.connectionStore.write(next);
    await this.session.dispose();
    this.session.connection = next;
    this.session.password = this.password;
    return this.describeConnection();
  }

  async disconnect() {
    this.password = null;
    await this.session.dispose();
    return this.describeConnection();
  }

  planKernelSession(kernel) {
    const conn = this.savedConnection || sanitize();
    const workspaceDir = kernel.workspace || this.workspaceDir || CANONICAL_WORKSPACE;
    const workspaceStrategy = this.workspaceStrategy(kernel);
    return {
      kernel,
      workspaceDir,
      connection: { host: conn.host, port: conn.port, username: conn.username },
      workspaceStrategy,
      fingerprint: [
        'ssh',
        kernel.id,
        conn.host || '-',
        String(conn.port || 22),
        conn.username || '-',
        workspaceDir,
      ].join('|'),
    };
  }

  workspaceStrategy(kernel) {
    const location = kernel?.workspace || this.workspaceDir || CANONICAL_WORKSPACE;
    return describeCopyStrategy({ location, reason: 'ssh' });
  }

  capabilities() {
    return describeCapabilities({
      implemented: true,
      interactiveTerminal: true,
      capturedCommands: true,
      exec: true,
      previewPorts: false,
      workspaceRetarget: false,
      nativeWatch: false,
    });
  }

  async probe() {
    const capabilities = this.capabilities();
    await this.loadSavedConnection();
    if (!this.savedConnection.host || !this.savedConnection.username) {
      return describeProbe({
        ok: false,
        implemented: true,
        ready: false,
        reason: 'ssh-unconfigured',
        details: this.describeConnection(),
        capabilities,
      });
    }
    try {
      await this.session.ensure();
      const commands = this.session.remoteTools
        || await this.session.probeTools().catch(() => null);
      const bash = Boolean(commands?.bash);
      return describeProbe({
        ok: bash,
        implemented: true,
        ready: bash,
        reason: bash ? 'ssh-ready' : 'bash-missing',
        details: {
          ...this.describeConnection(),
          workspace: this.session.workspaceLink,
          home: this.session.remoteHome,
          commands,
        },
        capabilities,
      });
    } catch (error) {
      this.session.lastError = error.message;
      return describeProbe({
        ok: false,
        implemented: true,
        ready: false,
        reason: 'ssh-failed',
        details: error.message,
        capabilities,
      });
    }
  }

  async applyKernel(kernel) {
    const plan = this.planKernelSession(kernel);
    this.workspaceDir = plan.workspaceDir;
    this.session.logicalWorkspace = plan.workspaceDir;
    this.session.workspaceStrategy = plan.workspaceStrategy;
    this.session.kernelId = kernel.id;
    this.session.connection = this.savedConnection;
    this.session.password = this.password;
    return plan;
  }

  async startSession() {
    await this.session.ensure();
    return this.session;
  }
}

export class SshRuntimeSession extends RuntimeSession {
  constructor({ provider, logicalWorkspace = CANONICAL_WORKSPACE }) {
    super();
    this.provider = provider;
    this.logicalWorkspace = logicalWorkspace;
    this.workspaceStrategy = null;
    this.kernelId = null;
    this.connection = sanitize();
    this.password = null;
    this.client = null;
    this.ready = false;
    this.lastError = null;
    this.remoteHome = null;
    this.workspaceLink = null;
    this.workspaceDir = null;
    this.rcRemotePath = null;
    this.connectPromise = null;
    this.remoteTools = null;
  }

  async probeTools() {
    const names = ['bash', 'gcc', 'gdb', 'make'];
    const commands = {};
    for (const name of names) {
      const result = await this.exec([
        'bash',
        '-lc',
        `if command -v ${name} >/dev/null 2>&1; then ${name} --version 2>/dev/null | head -n1; else exit 127; fi`,
      ], { cwd: this.remoteHome }).catch(() => ({ exitCode: 127, stdout: '' }));
      if (result.exitCode === 0) {
        const match = String(result.stdout || '').match(/[0-9]+(?:\.[0-9]+){0,3}/);
        commands[name] = match ? match[0] : true;
      } else {
        commands[name] = null;
      }
    }
    this.remoteTools = commands;
    return commands;
  }

  getPortMap() {
    return {};
  }

  async ensure() {
    if (this.client && this.ready) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connectUncached()
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async ensureWorkspace() {
    await this.ensure();
    const ws = shQuote(this.workspaceLink);
    const parent = shQuote(path.posix.dirname(this.workspaceLink));
    const result = await this.exec(
      ['bash', '-lc', `mkdir -p ${ws} && chmod 755 ${parent} ${ws}`],
      { cwd: this.remoteHome },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'failed to create remote workspace');
    }
  }

  async exec(cmdArray, opts = {}) {
    const client = await this.ensure();
    const mapped = (cmdArray || []).map(arg => mapCanonical(arg, this.workspaceLink));
    const cwd = mapCanonical(opts.cwd || this.workspaceLink || this.remoteHome, this.workspaceLink);
    const command = `cd ${shQuote(cwd)} && ${shellJoin(mapped)}`;
    return sshExec(client, command);
  }

  async writeFiles(files, opts = {}) {
    await this.ensureWorkspace();
    const root = this.workspaceLink;
    if (opts.clear !== false) {
      await this.exec(['bash', '-lc', `find -H ${shQuote(root)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`]);
    }
    const sftp = await sshSftp(this.client);
    try {
      for (const file of files || []) {
        const rel = validateWorkspaceRelPath(file.name || 'untitled');
        const dest = posixJoin(root, rel);
        if (file.type === 'dir') {
          await sftpMkdir(sftp, dest);
          continue;
        }
        await sftpMkdir(sftp, path.posix.dirname(dest));
        await sftpWrite(sftp, dest, file.content || '');
      }
    } finally {
      sftp.end();
    }
  }

  async readFiles() {
    await this.ensureWorkspace();
    const sftp = await sshSftp(this.client);
    try {
      return await sftpWalk(sftp, this.workspaceLink, '');
    } finally {
      sftp.end();
    }
  }

  async uploadScript(script, remotePath) {
    await this.ensure();
    const dest = mapCanonical(remotePath, this.workspaceLink);
    const rewritten = rewriteCanonicalWorkspace(script, this.workspaceLink);
    const sftp = await sshSftp(this.client);
    try {
      await sftpMkdir(sftp, path.posix.dirname(dest));
      await sftpWrite(sftp, dest, rewritten, 0o755);
    } finally {
      sftp.end();
    }
    return { path: dest };
  }

  async runCaptured(remoteScript, { timeoutMs } = {}) {
    const dest = mapCanonical(remoteScript, this.workspaceLink);
    const ms = Number(timeoutMs);
    const cmd = Number.isFinite(ms) && ms > 0
      ? ['timeout', '--signal=TERM', '--kill-after=2', String(Math.max(1, Math.ceil(ms / 1000))), 'bash', dest]
      : ['bash', dest];
    return this.exec(cmd);
  }

  async attachTerminal({ onOutput, onExit } = {}) {
    await this.ensureWorkspace();
    return this.#attachPty({
      command: `bash --rcfile ${shQuote(this.rcRemotePath)} -i`,
      onOutput,
      onExit,
    });
  }

  async attachCommand(remoteScript, { onOutput, onDone } = {}) {
    await this.ensureWorkspace();
    const dest = mapCanonical(remoteScript, this.workspaceLink);
    return this.#attachPty({
      command: `bash ${shQuote(dest)}`,
      onOutput,
      onExit(code) {
        onDone?.(code);
      },
    });
  }

  async interrupt(terminal) {
    terminal?.interrupt();
  }

  async resize(terminal, cols, rows) {
    await terminal?.resize(cols, rows);
  }

  async dispose() {
    this.ready = false;
    const client = this.client;
    this.client = null;
    this.lastError = null;
    this.remoteHome = null;
    this.workspaceLink = null;
    this.workspaceDir = null;
    this.remoteTools = null;
    if (client) {
      try { client.end(); } catch { /* already closed */ }
    }
  }

  async #connectUncached() {
    await this.dispose();
    const auth = await buildAuth(this.connection, this.password);
    try {
      const client = await sshConnect(auth);
      this.client = client;
      client.on('close', () => {
        if (this.client === client) {
          this.client = null;
          this.ready = false;
        }
      });
      const homeResult = await sshExec(client, 'printf %s "$HOME"');
      if (homeResult.exitCode !== 0 || !homeResult.stdout) {
        throw new Error(homeResult.stderr || 'could not read remote HOME');
      }
      this.remoteHome = homeResult.stdout.trim();
      this.workspaceLink = `${this.remoteHome}/.multilab/workspace`;
      this.workspaceDir = this.workspaceLink;
      this.rcRemotePath = `${this.remoteHome}/.multilab/bashrc`;
      await this.#installRemoteRc();
      this.ready = true;
      this.lastError = null;
      this.remoteTools = await this.probeTools().catch(() => null);
      return client;
    } catch (error) {
      this.lastError = error.message;
      this.ready = false;
      if (this.client) {
        try { this.client.end(); } catch { /* ignore */ }
        this.client = null;
      }
      throw error;
    }
  }

  async #installRemoteRc() {
    const contents = localRcFileContents({
      workspace: this.workspaceLink,
      home: this.remoteHome,
      pidDir: `${this.remoteHome}/.multilab/shells`,
      genFile: `${this.remoteHome}/.multilab/ws-gen`,
    });
    const sftp = await sshSftp(this.client);
    try {
      await sftpMkdir(sftp, `${this.remoteHome}/.multilab`);
      await sftpWrite(sftp, this.rcRemotePath, contents, 0o644);
    } finally {
      sftp.end();
    }
  }

  async #attachPty({ command, onOutput, onExit }) {
    const client = await this.ensure();
    const stream = await sshPty(client, `cd ${shQuote(this.workspaceLink)} && ${command}`);
    stream.on('data', chunk => onOutput?.(chunk.toString('utf8')));
    stream.stderr?.on('data', chunk => onOutput?.(chunk.toString('utf8')));
    stream.on('close', (code) => onExit?.(typeof code === 'number' ? code : 0));
    return {
      write(data) {
        stream.write(data);
      },
      interrupt() {
        stream.write('\x03');
      },
      async resize(cols, rows) {
        if (cols && rows && typeof stream.setWindow === 'function') {
          stream.setWindow(rows, cols, 0, 0);
        }
      },
      close() {
        try { stream.end(); } catch { /* gone */ }
      },
    };
  }
}

function mapCanonical(value, workspaceLink) {
  if (!workspaceLink) return String(value || '');
  return rewriteCanonicalWorkspace(String(value || ''), workspaceLink);
}

function posixJoin(root, rel) {
  return rel ? `${String(root).replace(/\/$/, '')}/${rel}` : root;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellJoin(cmdArray) {
  return (cmdArray || []).map((arg) => {
    const text = String(arg);
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
    return shQuote(text);
  }).join(' ');
}

async function buildAuth(connection, password) {
  const cfg = sanitize(connection);
  if (!cfg.host || !cfg.username) {
    const error = new Error('SSH host and username are required');
    error.statusCode = 400;
    error.code = 'ssh_unconfigured';
    throw error;
  }
  const auth = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    readyTimeout: 15000,
  };
  if (password) auth.password = password;
  if (cfg.privateKeyPath) {
    auth.privateKey = await fs.readFile(expandHome(cfg.privateKeyPath));
  } else {
    for (const name of DEFAULT_IDENTITIES) {
      try {
        auth.privateKey = await fs.readFile(path.join(os.homedir(), '.ssh', name));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  if (cfg.useAgent && !auth.privateKey) {
    const agent = defaultSshAgent();
    if (agent) auth.agent = agent;
  }
  if (!auth.privateKey && !auth.password && !auth.agent) {
    const error = new Error('SSH needs a private key, ssh-agent, or password');
    error.statusCode = 400;
    error.code = 'ssh_auth_missing';
    throw error;
  }
  return auth;
}

function explainSshError(error) {
  const code = error?.code || '';
  const msg = error?.message || String(error);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    const wrapped = new Error('SSH 端口没开。请先启动实验机，并确认 player 与端口转发在同一台机器上。');
    wrapped.statusCode = 502;
    wrapped.code = 'ssh_refused';
    wrapped.cause = error;
    return wrapped;
  }
  if (
    code === 'ECONNRESET'
    || /ECONNRESET|reset by peer|Connection reset|handshake|Connection lost before/i.test(msg)
  ) {
    const wrapped = new Error('已经连到端口，但实验机里的 sshd 没有回应。请在实验机上启动 sshd。');
    wrapped.statusCode = 502;
    wrapped.code = 'ssh_reset';
    wrapped.cause = error;
    return wrapped;
  }
  return error;
}

function sshConnect(auth) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (err, client) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { conn.end(); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(client);
      }
    };
    conn.on('ready', () => finish(null, conn));
    conn.on('error', error => finish(explainSshError(error)));
    conn.connect(auth);
  });
}

function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', chunk => { stdout += chunk.toString('utf8'); });
      stream.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 0 });
      });
      stream.on('error', reject);
    });
  });
}

function sshPty(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: { term: 'xterm-256color', cols: 80, rows: 24 } }, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function sshSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpWrite(sftp, dest, content, mode = 0o644) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = sftp.createWriteStream(dest, { mode });
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    stream.on('close', () => done());
    stream.on('error', done);
    stream.end(content);
  });
}

function sftpMkdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    if (!dir || dir === '/') {
      resolve();
      return;
    }
    sftp.mkdir(dir, (error) => {
      if (!error || isExistsError(error)) {
        resolve();
        return;
      }
      sftpMkdir(sftp, path.posix.dirname(dir)).then(() => {
        sftp.mkdir(dir, (again) => {
          if (!again || isExistsError(again)) resolve();
          else reject(again);
        });
      }).catch(reject);
    });
  });
}

function isExistsError(error) {
  return error?.code === 4 || error?.code === 11 || error?.code === 'EEXIST';
}

function isDirEntry(entry) {
  if (typeof entry?.attrs?.isDirectory === 'function') return entry.attrs.isDirectory();
  if (entry?.longname?.startsWith('d')) return true;
  return Boolean(entry?.attrs?.mode && (entry.attrs.mode & 0o40000));
}

async function sftpWalk(sftp, root, rel) {
  const dir = rel ? posixJoin(root, rel) : root;
  const names = await sftpReaddir(sftp, dir);
  const out = [];
  for (const entry of names) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    const name = rel ? `${rel}/${entry.filename}` : entry.filename;
    if (isDirEntry(entry)) {
      out.push({ name, type: 'dir' });
      out.push(...await sftpWalk(sftp, root, name));
    } else {
      const content = await sftpRead(sftp, posixJoin(root, name));
      out.push({ name, type: 'file', content });
    }
  }
  return out;
}

function sftpReaddir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (error, list) => {
      if (error) reject(error);
      else resolve(list || []);
    });
  });
}

function sftpRead(sftp, filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(filePath);
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
