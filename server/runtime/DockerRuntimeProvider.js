import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';

export class DockerRuntimeProvider extends RuntimeProvider {
  constructor({
    image,
    containerName,
    workspaceDir = '/home/student/workspace',
    docker = new Docker(),
  }) {
    super({ id: 'docker', kind: 'docker' });
    this.image = image;
    this.containerName = containerName;
    this.workspaceDir = workspaceDir;
    this.docker = docker;
    this.session = new DockerRuntimeSession({
      docker,
      image,
      containerName,
      workspaceDir,
    });
  }

  async startSession() {
    await this.session.ensure();
    return this.session;
  }
}

export class DockerRuntimeSession extends RuntimeSession {
  constructor({ docker, image, containerName, workspaceDir }) {
    super();
    this.docker = docker;
    this.image = image;
    this.containerName = containerName;
    this.workspaceDir = workspaceDir;
    this.container = null;
    this.containerPromise = null;
    this.workspaceReady = false;
  }

  async ensure() {
    if (this.container) return this.container;
    if (this.containerPromise) return this.containerPromise;

    this.containerPromise = this.#ensureContainerUncached()
      .then(container => {
        this.container = container;
        return container;
      })
      .finally(() => {
        this.containerPromise = null;
      });
    return this.containerPromise;
  }

  async ensureWorkspace() {
    if (this.workspaceReady) return;
    await this.exec(['mkdir', '-p', this.workspaceDir], { user: 'root', cwd: '/' });
    await this.exec(['chown', '-R', 'student:student', this.workspaceDir], { user: 'root', cwd: '/' });
    this.workspaceReady = true;
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
      lines.push(`find ${shQuote(this.workspaceDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
    }
    for (const f of files || []) {
      const name = validateFileName(f.name || 'untitled');
      const dest = pathJoinPosix(this.workspaceDir, name);
      const encoded = Buffer.from(f.content || '', 'utf8').toString('base64');
      const heredoc = `EOF_${encoded.length}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
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
find . -maxdepth 1 -type f -printf '%f\\n' | sort | while IFS= read -r name; do
  printf '%s\\t' "$(printf '%s' "$name" | base64 -w0)"
  base64 -w0 "$name"
  printf '\\n'
done
`;
    const r = await this.exec(['bash', '-lc', script], { cwd: '/' });
    if (r.exitCode !== 0) throw new Error(r.stderr || 'workspace listing failed');
    return r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [encodedName, encodedContent] = line.split('\t');
      const name = Buffer.from(encodedName, 'base64').toString('utf8');
      validateFileName(name);
      return {
        name,
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
      Cmd: ['tar', '-czf', '-', '-C', '/home/student', 'workspace'],
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
      Env: [
        'PS1=\\[\\e[01;32m\\]\\u@\\h\\[\\e[00m\\]:\\[\\e[01;34m\\]\\w\\[\\e[00m\\]$ ',
        'TERM=xterm-256color',
        'LANG=C.UTF-8',
        'LC_ALL=C.UTF-8',
      ],
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

    const containers = await this.docker.listContainers({ all: true });
    const existing = containers.find(c => c.Names.includes('/' + this.containerName));

    if (existing) {
      if (existing.State !== 'running') {
        console.log(`[docker] 启动已存在的容器 ${this.containerName}`);
        await this.docker.getContainer(existing.Id).start();
      } else {
        console.log(`[docker] 容器 ${this.containerName} 已在运行`);
      }
      return this.docker.getContainer(existing.Id);
    }

    console.log(`[docker] 创建并启动新容器 ${this.containerName}`);
    const container = await this.docker.createContainer({
      name: this.containerName,
      Hostname: 'tutorial',
      Image: this.image,
      Cmd: ['sleep', 'infinity'],
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        AutoRemove: false,
      },
    });
    await container.start();
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

function validateFileName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw Object.assign(new Error('Invalid file name'), { statusCode: 400 });
  }
  return name;
}

