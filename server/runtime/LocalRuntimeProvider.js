import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';
import { describeCapabilities, describeProbe } from './RuntimeContract.js';
import { describeHostLocalStrategy } from '../workspace/WorkspaceStrategy.js';
import { validateWorkspaceRelPath } from '../services/PackageService.js';
import {
  CANONICAL_WORKSPACE,
  LOCAL_SHELL_PID_DIR,
  LOCAL_WORKSPACE_GEN,
  LOCAL_WORKSPACE_LINK,
  localRcFileContents,
  localShellEnv,
  rewriteCanonicalWorkspace,
  signalLocalShellsScript,
} from './localShellEnv.js';

let ptyModulePromise = null;

function loadPty() {
  if (!ptyModulePromise) {
    ptyModulePromise = import('node-pty').then(mod => mod.default || mod).catch(() => null);
  }
  return ptyModulePromise;
}

export class LocalRuntimeProvider extends RuntimeProvider {
  constructor({
    workspaceDir = CANONICAL_WORKSPACE,
    hostSavesDir = null,
    workspaceLink = LOCAL_WORKSPACE_LINK,
  } = {}) {
    super({ id: 'local', kind: 'local' });
    this.workspaceDir = workspaceDir;
    this.hostSavesDir = hostSavesDir;
    this.workspaceLink = workspaceLink;
    this.session = new LocalRuntimeSession({
      provider: this,
      workspaceLink,
      hostSavesDir,
      logicalWorkspace: workspaceDir,
    });
  }

  planKernelSession(kernel) {
    const workspaceDir = kernel.workspace || this.workspaceDir || CANONICAL_WORKSPACE;
    const workspaceStrategy = this.workspaceStrategy(kernel);
    return {
      kernel,
      workspaceDir,
      workspaceLink: this.workspaceLink,
      workspaceStrategy,
      fingerprint: [
        'local',
        kernel.id,
        workspaceDir,
        this.workspaceLink,
        workspaceStrategy.hostPath || '-',
      ].join('|'),
    };
  }

  workspaceStrategy(kernel) {
    const location = kernel?.workspace || this.workspaceDir || CANONICAL_WORKSPACE;
    return describeHostLocalStrategy({
      location,
      hostPath: this.hostSavesDir,
      reason: 'this-computer',
    });
  }

  capabilities() {
    return describeCapabilities({
      implemented: true,
      interactiveTerminal: true,
      capturedCommands: true,
      exec: true,
      previewPorts: false,
      workspaceRetarget: true,
      nativeWatch: true,
    });
  }

  async probe() {
    const capabilities = this.capabilities();
    try {
      await fs.access(this.workspaceLink).catch(() => {});
      const bash = await commandVersion('bash');
      return describeProbe({
        ok: Boolean(bash),
        implemented: true,
        ready: Boolean(bash),
        reason: bash ? 'local-shell' : 'bash-missing',
        details: {
          home: os.homedir(),
          workspace: this.workspaceLink,
          bash,
        },
        capabilities,
      });
    } catch (error) {
      return describeProbe({
        ok: false,
        implemented: true,
        ready: false,
        reason: 'local-unavailable',
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
    return plan;
  }

  async startSession() {
    await this.session.ensure();
    return this.session;
  }
}

export class LocalRuntimeSession extends RuntimeSession {
  constructor({
    provider,
    workspaceLink = LOCAL_WORKSPACE_LINK,
    hostSavesDir = null,
    logicalWorkspace = CANONICAL_WORKSPACE,
  }) {
    super();
    this.provider = provider;
    this.workspaceLink = workspaceLink;
    this.workspaceDir = workspaceLink;
    this.hostSavesDir = hostSavesDir;
    this.logicalWorkspace = logicalWorkspace;
    this.workspaceStrategy = null;
    this.kernelId = null;
    this.rcFile = path.join(os.homedir(), '.multilab', 'bashrc');
    this.ready = false;
    this.shellPids = new Set();
  }

  getPortMap() {
    return {};
  }

  async ensure() {
    await fs.mkdir(path.dirname(this.workspaceLink), { recursive: true });
    await fs.mkdir(LOCAL_SHELL_PID_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_WORKSPACE_GEN), { recursive: true });
    await this.#writeRcFile();
    if (!(await pathExists(this.workspaceLink))) {
      const idle = path.join(path.dirname(this.workspaceLink), 'workspace-idle');
      await fs.mkdir(idle, { recursive: true });
      await fs.symlink(idle, this.workspaceLink).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    this.ready = true;
    return true;
  }

  async ensureWorkspace() {
    await this.ensure();
  }

  async pointWorkspace(hostPath) {
    await this.ensure();
    const target = path.resolve(hostPath);
    await fs.mkdir(target, { recursive: true });
    await this.exec(['ln', '-sfn', target, this.workspaceLink], {
      cwd: path.dirname(this.workspaceLink),
    });
    await fs.writeFile(LOCAL_WORKSPACE_GEN, `${Date.now()}\n`, 'utf8');
    await this.exec(['bash', '-lc', signalLocalShellsScript()]);
  }

  async exec(cmdArray, opts = {}) {
    await this.ensure();
    const cwd = opts.cwd || this.workspaceLink;
    return spawnCaptured(cmdArray, {
      cwd,
      env: { ...localShellEnv({ workspace: this.workspaceLink }), ...(opts.env || {}) },
      timeoutMs: opts.timeoutMs,
    });
  }

  async writeFiles(files, opts = {}) {
    await this.ensureWorkspace();
    const root = await fs.realpath(this.workspaceLink).catch(() => this.workspaceLink);
    if (opts.clear !== false) {
      const entries = await fs.readdir(root).catch(() => []);
      await Promise.all(entries.map(name => fs.rm(path.join(root, name), { recursive: true, force: true })));
    }
    for (const file of files || []) {
      const rel = validateWorkspaceRelPath(file.name || 'untitled');
      const dest = path.join(root, ...rel.split('/'));
      if (file.type === 'dir') {
        await fs.mkdir(dest, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content || '', 'utf8');
    }
  }

  async readFiles() {
    await this.ensureWorkspace();
    const root = await fs.realpath(this.workspaceLink).catch(() => this.workspaceLink);
    return walkFiles(root, '');
  }

  async uploadScript(script, remotePath) {
    await this.ensure();
    const rewritten = rewriteCanonicalWorkspace(script, this.workspaceLink);
    await fs.writeFile(remotePath, rewritten, { encoding: 'utf8', mode: 0o755 });
    return { path: remotePath };
  }

  async runCaptured(remoteScript, { timeoutMs } = {}) {
    const ms = Number(timeoutMs);
    const cmd = Number.isFinite(ms) && ms > 0
      ? ['timeout', '--signal=TERM', '--kill-after=2', String(Math.max(1, Math.ceil(ms / 1000))), 'bash', remoteScript]
      : ['bash', remoteScript];
    return this.exec(cmd, { cwd: this.workspaceLink });
  }

  async attachTerminal({ onOutput, onExit } = {}) {
    await this.ensureWorkspace();
    return this.#attachPty({
      args: ['--rcfile', this.rcFile, '-i'],
      cwd: this.workspaceLink,
      onOutput,
      onExit,
    });
  }

  async attachCommand(remoteScript, { onOutput, onDone } = {}) {
    await this.ensureWorkspace();
    return this.#attachPty({
      args: ['--rcfile', this.rcFile, remoteScript],
      cwd: this.workspaceLink,
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

  async #attachPty({ args, cwd, onOutput, onExit }) {
    const pty = await loadPty();
    const env = localShellEnv({ workspace: this.workspaceLink });
    if (pty) {
      const proc = pty.spawn('bash', args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
      proc.onData(data => onOutput?.(data));
      proc.onExit(({ exitCode }) => onExit?.(exitCode ?? 0));
      return {
        write(data) {
          proc.write(data);
        },
        interrupt() {
          proc.write('\x03');
        },
        async resize(cols, rows) {
          if (cols && rows) proc.resize(cols, rows);
        },
        close() {
          try { proc.kill(); } catch { /* already gone */ }
        },
      };
    }
    return attachPipeBash({ args, cwd, env, onOutput, onExit });
  }

  async #writeRcFile() {
    await fs.mkdir(path.dirname(this.rcFile), { recursive: true });
    await fs.writeFile(this.rcFile, localRcFileContents({
      workspace: this.workspaceLink,
    }), 'utf8');
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function commandVersion(name) {
  const result = await spawnCaptured([name, '--version'], { cwd: os.homedir() }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const text = `${result.stdout}\n${result.stderr}`;
  const match = text.match(/[0-9]+(?:\.[0-9]+){0,3}/);
  return match ? match[0] : true;
}

function spawnCaptured(cmdArray, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmdArray[0], cmdArray.slice(1), {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      resolve({ stdout, stderr, exitCode });
    };
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', finish);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }, 2000);
      }, timeoutMs);
    }
  });
}

function attachPipeBash({ args, cwd, env, onOutput, onExit }) {
  const child = spawn('bash', args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => onOutput?.(chunk.toString('utf8')));
  child.stderr.on('data', chunk => onOutput?.(chunk.toString('utf8')));
  child.on('close', code => onExit?.(code ?? 0));
  return {
    write(data) {
      child.stdin.write(data);
    },
    interrupt() {
      try { child.kill('SIGINT'); } catch { /* gone */ }
    },
    async resize() {},
    close() {
      try { child.kill(); } catch { /* gone */ }
    },
  };
}

async function walkFiles(root, rel) {
  const dir = rel ? path.join(root, rel) : root;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ name, type: 'dir' });
      out.push(...await walkFiles(root, name));
    } else if (entry.isFile()) {
      const content = await fs.readFile(path.join(root, name), 'utf8');
      out.push({ name, type: 'file', content });
    }
  }
  return out;
}
