import Docker from 'dockerode';
import { PassThrough } from 'stream';
import crypto from 'crypto';
import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';
import {
  allocatePortBindings,
  normalizePublishPorts,
  portMapFromInspect,
} from '../services/PreviewPortMap.js';
import { chooseDockerWorkspaceStrategy, SAVES_BIND_TARGET } from '../workspace/WorkspaceStrategy.js';
import { ensureHostWorkspaceDir } from '../workspace/HostWorkspace.js';
import { validateWorkspaceRelPath } from '../services/PackageService.js';
import { learnerShellEnv, learnerProfileSnippet } from './learnerShellEnv.js';

export class DockerRuntimeProvider extends RuntimeProvider {
  constructor({
    image,
    containerName,
    workspaceDir = '/home/student/workspace',
    hostWorkspaceDir = null,
    hostSavesDir = null,
    workspaceStrategyMode = process.env.WORKSPACE_STRATEGY || 'auto',
    docker = new Docker(),
  }) {
    super({ id: 'docker', kind: 'docker' });
    this.defaultImage = image;
    this.image = image;
    this.containerName = containerName;
    this.workspaceDir = workspaceDir;
    this.hostSavesDir = hostSavesDir || hostWorkspaceDir;
    this.workspaceStrategyMode = workspaceStrategyMode;
    this.networkMode = 'none';
    this.sandboxPreset = 'standard';
    this.publishPorts = [];
    this.kernelId = null;
    this.docker = docker;
    this.session = new DockerRuntimeSession({
      provider: this,
      docker,
      containerName,
    });
  }

  planKernelSession(kernel) {
    const image = kernel.image || this.defaultImage;
    const workspaceDir = kernel.workspace || this.workspaceDir || '/home/student/workspace';
    const networkMode = kernel.network_default === 'none' ? 'none' : 'bridge';
    const sandboxPreset = pickSandboxPreset(kernel);
    // Port publish only works with a real network mode (not none).
    const publishPorts = networkMode === 'none'
      ? []
      : normalizePublishPorts(kernel.publish_ports);
    const workspaceStrategy = this.workspaceStrategy(kernel);
    return {
      kernel,
      image,
      workspaceDir,
      networkMode,
      sandboxPreset,
      publishPorts,
      workspaceStrategy,
      fingerprint: [
        'docker',
        kernel.id,
        image,
        workspaceDir,
        networkMode,
        sandboxPreset,
        publishPorts.join(','),
        workspaceStrategy.kind,
        workspaceStrategy.bindTarget || workspaceStrategy.location,
        workspaceStrategy.hostPath || '-',
      ].join('|'),
    };
  }

  workspaceStrategy(kernel) {
    const location = kernel?.workspace || this.workspaceDir || '/home/student/workspace';
    return chooseDockerWorkspaceStrategy({
      location,
      hostPath: this.hostSavesDir,
      bindTarget: SAVES_BIND_TARGET,
      mode: this.workspaceStrategyMode,
    });
  }

  async applyKernel(kernel) {
    const plan = this.planKernelSession(kernel);
    this.kernelId = kernel.id;
    this.image = plan.image;
    this.workspaceDir = plan.workspaceDir;
    this.networkMode = plan.networkMode;
    this.sandboxPreset = plan.sandboxPreset;
    this.publishPorts = plan.publishPorts;
    this.session.image = plan.image;
    this.session.workspaceDir = plan.workspaceDir;
    this.session.networkMode = plan.networkMode;
    this.session.sandboxPreset = plan.sandboxPreset;
    this.session.publishPorts = plan.publishPorts;
    this.session.kernelId = kernel.id;
    this.session.policyFingerprint = plan.fingerprint;
    this.session.workspaceStrategy = plan.workspaceStrategy;
    return plan;
  }

  async startSession() {
    await this.session.ensure();
    return this.session;
  }
}

export class DockerRuntimeSession extends RuntimeSession {
  constructor({ provider, docker, containerName }) {
    super();
    this.provider = provider;
    this.docker = docker;
    this.containerName = containerName;
    this.image = provider.image;
    this.workspaceDir = provider.workspaceDir;
    this.networkMode = provider.networkMode;
    this.sandboxPreset = provider.sandboxPreset;
    this.publishPorts = provider.publishPorts || [];
    this.kernelId = provider.kernelId;
    this.policyFingerprint = null;
    this.container = null;
    this.containerPromise = null;
    this.workspaceReady = false;
    this.appliedFingerprint = null;
    this.portMap = {};
    this.workspaceStrategy = provider.workspaceStrategy?.(null) || null;
  }

  getPortMap() {
    return { ...this.portMap };
  }

  async ensure() {
    if (this.container && this.appliedFingerprint === this.policyFingerprint) {
      return this.container;
    }
    if (this.containerPromise) return this.containerPromise;

    this.containerPromise = this.#ensureContainerUncached()
      .then(container => {
        this.container = container;
        this.appliedFingerprint = this.policyFingerprint;
        return container;
      })
      .finally(() => {
        this.containerPromise = null;
      });
    return this.containerPromise;
  }

  async ensureWorkspace() {
    if (this.workspaceReady) return;
    const hostPath = this.workspaceStrategy?.hostPath;
    if (hostPath) {
      await ensureHostWorkspaceDir(hostPath);
    }
    await this.#alignStudentUid();
    await this.exec(['mkdir', '-p', this.workspaceDir, SAVES_BIND_TARGET], { user: 'root', cwd: '/' });
    if (!hostPath) {
      await this.exec(['chown', '-R', 'student:student', this.workspaceDir], { user: 'root', cwd: '/' });
    }
    await this.#installLearnerShellHook();
    this.workspaceReady = true;
  }

  async pointWorkspace(containerPath) {
    await this.ensure();
    const target = String(containerPath || '');
    if (!target.startsWith(`${SAVES_BIND_TARGET}/`) && target !== SAVES_BIND_TARGET) {
      throw Object.assign(new Error('workspace target escapes save bind'), { statusCode: 403 });
    }
    const quotedTarget = shQuote(target);
    const quotedWs = shQuote(this.workspaceDir);
    const script = `
set -e
mkdir -p ${shQuote(SAVES_BIND_TARGET)} "$(dirname ${quotedTarget})" ${quotedTarget}
# Never rm -rf the workspace: it may already be a bind of the save dir.
if [ -L ${quotedWs} ]; then rm -f ${quotedWs}; fi
mkdir -p ${quotedWs}
if mountpoint -q ${quotedWs} 2>/dev/null; then
  umount ${quotedWs} 2>/dev/null || umount -l ${quotedWs} 2>/dev/null || true
fi
if mount --bind ${quotedTarget} ${quotedWs} 2>/dev/null; then
  exit 0
fi
# Fallback: symlink. Prompt env hides the physical .mlab-saves path.
rmdir ${quotedWs} 2>/dev/null || true
ln -sfn ${quotedTarget} ${quotedWs}
`;
    let result = await this.exec(['bash', '-lc', script], {
      user: 'root',
      cwd: '/',
      privileged: true,
    });
    if (result.exitCode !== 0) {
      result = await this.exec(['bash', '-lc', script], { user: 'root', cwd: '/' });
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'failed to point workspace at save directory');
    }
  }

  async #installLearnerShellHook() {
    const snippet = learnerProfileSnippet();
    const result = await this.exec(['bash', '-lc', `
cat > /etc/profile.d/multilab-workspace.sh << 'EOF'
${snippet}EOF
chmod 644 /etc/profile.d/multilab-workspace.sh
`], { user: 'root', cwd: '/' });
    if (result.exitCode !== 0) {
      console.warn(`[docker] learner shell hook not installed: ${result.stderr || result.stdout}`);
    }
  }

  async #alignStudentUid() {
    if (typeof process.getuid !== 'function' || process.platform === 'win32') return;
    const uid = process.getuid();
    const gid = process.getgid();
    if (!Number.isInteger(uid) || uid === 0) return;
    const script = `
set -e
HOST_UID=${uid}
HOST_GID=${gid}
CURRENT=$(id -u student 2>/dev/null || echo '')
if [ "$CURRENT" = "$HOST_UID" ]; then exit 0; fi
if getent passwd "$HOST_UID" >/dev/null; then
  OCC=$(getent passwd "$HOST_UID" | cut -d: -f1)
  if [ "$OCC" != "student" ]; then
    usermod -u $((HOST_UID + 20000)) "$OCC" 2>/dev/null || true
  fi
fi
if getent group "$HOST_GID" >/dev/null; then
  GOCC=$(getent group "$HOST_GID" | cut -d: -f1)
  if [ "$GOCC" != "student" ]; then
    groupmod -g $((HOST_GID + 20000)) "$GOCC" 2>/dev/null || true
  fi
fi
groupmod -g "$HOST_GID" student 2>/dev/null || groupadd -g "$HOST_GID" student
usermod -u "$HOST_UID" -g "$HOST_GID" student
chown student:student /home/student 2>/dev/null || true
`;
    await this.exec(['bash', '-lc', script], { user: 'root', cwd: '/' });
  }

  async exec(cmdArray, opts = {}) {
    const container = await this.ensure();
    const envList = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8'];
    if (opts.env) {
      Object.entries(opts.env).forEach(([k, v]) => envList.push(`${k}=${v}`));
    }
    const exec = await container.exec({
      Cmd: cmdArray,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user || 'student',
      Privileged: Boolean(opts.privileged),
      WorkingDir: opts.cwd || this.workspaceDir,
      Env: envList,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const stdoutPipe = new PassThrough();
      const stderrPipe = new PassThrough();
      container.modem.demuxStream(stream, stdoutPipe, stderrPipe);
      stdoutPipe.on('data', d => stdout += d.toString('utf8'));
      stderrPipe.on('data', d => stderr += d.toString('utf8'));
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          resolve({ stdout, stderr, exitCode: info.ExitCode });
        } catch {
          resolve({ stdout, stderr, exitCode: -1 });
        }
      });
      stream.on('error', reject);
    });
  }

  async writeFiles(files, opts = {}) {
    await this.ensureWorkspace();
    const lines = ['set -e'];
    if (opts.clear !== false) {
      lines.push(`find -H ${shQuote(this.workspaceDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
    }
    for (const f of files || []) {
      const rel = validateWorkspaceRelPath(f.name || 'untitled');
      const dest = pathJoinPosix(this.workspaceDir, rel);
      if (f.type === 'dir') {
        lines.push(`mkdir -p ${shQuote(dest)}`);
        continue;
      }
      const parent = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : this.workspaceDir;
      lines.push(`mkdir -p ${shQuote(parent)}`);
      const encoded = Buffer.from(f.content || '', 'utf8').toString('base64');
      const heredoc = `EOF_${encoded.length}_${rel.replace(/[^a-zA-Z0-9]/g, '_')}`;
      lines.push(`base64 -d > ${shQuote(dest)} <<'${heredoc}'`);
      lines.push(encoded);
      lines.push(heredoc);
    }
    const r = await this.exec(['bash', '-lc', lines.join('\n')], { cwd: '/' });
    if (r.exitCode !== 0) throw new Error(r.stderr || 'failed to write workspace');
  }

  async readFiles() {
    await this.ensureWorkspace();
    const script = `
set -e
cd ${this.workspaceDir}
find . -mindepth 1 -maxdepth 8 \\( -type f -o -type d \\) -printf '%y\\t%P\\n' | sort | while IFS=$'\\t' read -r kind rel; do
  [ -z "$rel" ] && continue
  encoded="$(printf '%s' "$rel" | base64 -w0)"
  if [ "$kind" = "d" ]; then
    printf 'd\\t%s\\n' "$encoded"
  else
    printf 'f\\t%s\\t' "$encoded"
    base64 -w0 "$rel"
    printf '\\n'
  fi
done
`;
    const r = await this.exec(['bash', '-lc', script], { cwd: '/' });
    if (r.exitCode !== 0) throw new Error(r.stderr || 'workspace listing failed');
    return r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [kind, encodedName, encodedContent] = line.split('\t');
      const name = validateWorkspaceRelPath(Buffer.from(encodedName, 'base64').toString('utf8'));
      if (kind === 'd') return { name, type: 'dir' };
      return {
        name,
        type: 'file',
        content: Buffer.from(encodedContent || '', 'base64').toString('utf8'),
      };
    });
  }

  async uploadScript(script, remotePath) {
    const container = await this.ensure();
    const writeExec = await container.exec({
      Cmd: ['tee', remotePath],
      AttachStdin: true,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });
    const writeStream = await writeExec.start({ hijack: true, stdin: true });
    writeStream.on('error', (e) => { throw e; });
    writeStream.end(script);
    await this.#waitForExec(writeExec);
  }

  async runCaptured(remoteScript) {
    return this.exec(['bash', remoteScript]);
  }

  async exportWorkspaceArchive() {
    const container = await this.ensure();
    const exec = await container.exec({
      Cmd: ['tar', '-czf', '-', '-C', '/home/student/workspace', '.'],
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks = [];
    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    let stderr = '';

    container.modem.demuxStream(stream, stdoutPipe, stderrPipe);
    stdoutPipe.on('data', d => chunks.push(d));
    stderrPipe.on('data', d => stderr += d.toString('utf8'));

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const info = await exec.inspect().catch(() => ({ ExitCode: -1 }));
    if (info.ExitCode !== 0) {
      throw new Error(stderr || 'workspace export failed');
    }
    return Buffer.concat(chunks);
  }

  async attachTerminal({
    onOutput,
    onExit,
  } = {}) {
    await this.ensureWorkspace();
    const container = await this.ensure();
    const shellExec = await container.exec({
      Cmd: ['bash', '--login', '-i'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'student',
      WorkingDir: this.workspaceDir,
      Env: learnerShellEnv(),
    });
    const shellStream = await shellExec.start({ hijack: true, stdin: true });
    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();

    container.modem.demuxStream(shellStream, stdoutPipe, stderrPipe);
    stdoutPipe.on('data', chunk => onOutput?.(chunk.toString('utf8')));
    stderrPipe.on('data', chunk => onOutput?.(chunk.toString('utf8')));
    shellStream.on('end', () => onExit?.());

    return {
      write(data) {
        shellStream.write(data);
      },
      interrupt() {
        shellStream.write('\x03');
      },
      async resize(cols, rows) {
        await shellExec.resize({ h: rows, w: cols });
      },
      close() {
        shellStream.destroy();
      },
      runScript(remoteScript) {
        shellStream.write(`bash ${remoteScript}\n`);
      },
    };
  }

  async interrupt(terminal) {
    terminal?.interrupt();
  }

  async resize(terminal, cols, rows) {
    await terminal?.resize(cols, rows);
  }

  async #ensureContainerUncached() {
    const images = await this.docker.listImages();
    const exists = images.some(img =>
      (img.RepoTags || []).includes(this.image)
    );
    if (!exists) {
      throw new Error(
        `执行镜像 ${this.image} 未构建。请先运行:\n` +
        `  docker build -t ${this.image} -f docker/os.Dockerfile docker/`
      );
    }

    const publishPorts = normalizePublishPorts(this.publishPorts);
    const workspaceStrategy = this.workspaceStrategy || { kind: 'runtime-internal', hostPath: null };
    if (workspaceStrategy.hostPath) {
      await ensureHostWorkspaceDir(workspaceStrategy.hostPath);
    }
    const desired = desiredContainerLabels({
      kernelId: this.kernelId,
      image: this.image,
      networkMode: this.networkMode,
      sandboxPreset: this.sandboxPreset,
      publishPorts,
      workspaceKind: workspaceStrategy.kind,
      workspaceHost: workspaceStrategy.hostPath,
      workspaceBind: workspaceStrategy.bindTarget || null,
    });

    const containers = await this.docker.listContainers({ all: true });
    const existing = containers.find(c => c.Names.includes('/' + this.containerName));

    if (existing) {
      const container = this.docker.getContainer(existing.Id);
      const inspect = await container.inspect();
      const labels = inspect.Config?.Labels || {};
      if (labelsMatch(labels, desired)) {
        if (existing.State !== 'running') {
          console.log(`[docker] 启动已存在的容器 ${this.containerName}`);
          await container.start();
        } else {
          console.log(`[docker] 容器 ${this.containerName} 已在运行 (kernel=${this.kernelId || 'default'})`);
        }
        this.portMap = portMapFromInspect(inspect);
        this.workspaceReady = false;
        return container;
      }

      console.log(
        `[docker] 容器 ${this.containerName} 策略不匹配，按 kernel 重建 ` +
        `(network=${this.networkMode}, sandbox=${this.sandboxPreset}, ` +
        `workspace=${workspaceStrategy.kind}, ports=${publishPorts.join(',') || '-'})`
      );
      try {
        if (existing.State === 'running') await container.stop({ t: 5 });
      } catch {
        // Container may already be stopped.
      }
      await container.remove({ force: true });
      this.container = null;
      this.portMap = {};
      this.workspaceReady = false;
    }

    console.log(
      `[docker] 创建并启动新容器 ${this.containerName} ` +
      `(kernel=${this.kernelId || 'default'}, network=${this.networkMode}, ` +
      `sandbox=${this.sandboxPreset}, workspace=${workspaceStrategy.kind}, ports=${publishPorts.join(',') || '-'})`
    );
    const hostConfig = {
      AutoRemove: false,
      NetworkMode: this.networkMode,
    };
    if (this.sandboxPreset !== 'none') {
      hostConfig.SecurityOpt = ['no-new-privileges:true'];
    }
    if (workspaceStrategy.hostPath) {
      hostConfig.Mounts = [{
        Target: workspaceStrategy.bindTarget || this.workspaceDir,
        Source: workspaceStrategy.hostPath,
        Type: 'bind',
        ReadOnly: false,
      }];
    }

    let exposedPorts;
    if (publishPorts.length && this.networkMode !== 'none') {
      const allocated = await allocatePortBindings(publishPorts);
      hostConfig.PortBindings = allocated.portBindings;
      exposedPorts = allocated.exposedPorts;
      this.portMap = allocated.portMap;
    } else {
      this.portMap = {};
    }

    const createOpts = {
      name: this.containerName,
      Hostname: 'tutorial',
      Image: this.image,
      Cmd: ['sleep', 'infinity'],
      Tty: true,
      OpenStdin: true,
      Labels: desired,
      HostConfig: hostConfig,
    };
    if (exposedPorts) createOpts.ExposedPorts = exposedPorts;

    const container = await this.docker.createContainer(createOpts);
    await container.start();
    this.workspaceReady = false;
    return container;
  }

  async #waitForExec(exec) {
    return new Promise((resolve, reject) => {
      let done = false;
      const check = setInterval(async () => {
        try {
          const info = await exec.inspect();
          if (!info.Running) {
            done = true;
            clearInterval(check);
            resolve(info.ExitCode);
          }
        } catch (e) {
          done = true;
          clearInterval(check);
          reject(e);
        }
      }, 10);
      setTimeout(() => {
        if (!done) {
          clearInterval(check);
          reject(new Error('docker exec timed out'));
        }
      }, 30000);
    });
  }
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function pathJoinPosix(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}

function pickSandboxPreset(kernel) {
  const presets = Array.isArray(kernel.sandbox_presets) ? kernel.sandbox_presets : [];
  if (presets.includes('standard')) return 'standard';
  if (presets.length) return presets[0];
  if ((kernel.capabilities || []).includes('sandbox')) return 'standard';
  return 'none';
}

function desiredContainerLabels({
  kernelId,
  image,
  networkMode,
  sandboxPreset,
  publishPorts = [],
  workspaceKind = 'runtime-internal',
  workspaceHost = null,
  workspaceBind = null,
}) {
  return {
    'multilab.kernel.id': String(kernelId || ''),
    'multilab.image': String(image || ''),
    'multilab.network': String(networkMode || ''),
    'multilab.sandbox': String(sandboxPreset || ''),
    'multilab.publish': normalizePublishPorts(publishPorts).join(',') || '-',
    'multilab.workspace.kind': String(workspaceKind || 'runtime-internal'),
    'multilab.workspace.bind': String(workspaceBind || '-'),
    'multilab.workspace.host': workspaceHost
      ? crypto.createHash('sha256').update(String(workspaceHost)).digest('hex').slice(0, 12)
      : '-',
  };
}

function labelsMatch(actual, desired) {
  return Object.entries(desired).every(([key, value]) => actual?.[key] === value);
}

