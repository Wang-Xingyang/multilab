import { validateSafePath } from './PackageService.js';
import { buildPreviewMeta } from './PreviewPortMap.js';
import { capturedTimeoutMs } from '../runtime/RuntimeContract.js';
import crypto from 'crypto';

export class CommandService {
  constructor({
    packageService,
    runtimeManager,
    runtimeSession = null,
    securityPolicyService = null,
    saveService = null,
  }) {
    this.packageService = packageService;
    this.runtimeManager = runtimeManager;
    this.runtimeSession = runtimeSession;
    this.securityPolicyService = securityPolicyService;
    this.saveService = saveService;
  }

  async runCapturedCommand({ tutorial, step, command, generation = null }) {
    validateSafePath(tutorial);
    validateSafePath(step);
    validateSafePath(command);

    const auth = await this.authorizeCommand({ tutorial });
    const session = await this.ensureRuntimeSession(auth);
    const commandSpec = await this.packageService.getStepCommandScript(tutorial, step, command);
    if (commandSpec.command.terminal === 'interactive') {
      throw Object.assign(
        new Error('interactive command must run through WebSocket terminal'),
        { statusCode: 400 }
      );
    }
    if (this.saveService) {
      await this.saveService.assertStepCommand(tutorial, step, {
        generation,
        requireEditable: commandSpec.command.type === 'test',
      });
    }

    const commandToken = crypto.randomUUID();
    this.saveService?.beginCommand?.({ tutorial, step, generation, token: commandToken });
    try {
      const remoteScript = session.tempScriptPath(step, command);
      await session.uploadScript(commandSpec.script, remoteScript);
      const result = await session.runCaptured(remoteScript, {
        timeoutMs: capturedTimeoutMs(commandSpec.command),
      });
      const passed = result.exitCode === 0;
      const progress = commandSpec.command.type === 'test' && this.saveService
        ? await this.saveService.recordTestResult(tutorial, step, passed)
        : null;
      const output = (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim();
      const portMap = session.getPortMap();
      const previewMeta = commandSpec.command.type === 'preview'
        ? buildPreviewMeta(output, portMap)
        : {};
      return {
        command,
        exitCode: result.exitCode,
        passed,
        output,
        kernel: auth?.kernel ? { id: auth.kernel.id, provider: auth.kernel.provider } : undefined,
        ...(progress ? { progress } : {}),
        ...previewMeta,
      };
    } finally {
      this.saveService?.finishCommand?.(commandToken);
    }
  }

  async runInteractiveCommand({
    tutorial,
    step,
    command,
    generation = null,
    completionToken = null,
    hooks = {},
  }) {
    validateSafePath(tutorial);
    validateSafePath(step);
    validateSafePath(command);

    const auth = await this.authorizeCommand({ tutorial });
    const ensured = await this.ensureRuntime(auth);
    if (ensured.replaced) {
      throw Object.assign(
        new Error('Runtime was replaced for the selected kernel; reconnect the terminal and retry'),
        { statusCode: 409, code: 'runtime_replaced' }
      );
    }
    const commandSpec = await this.packageService.getStepCommandScript(tutorial, step, command);
    if (commandSpec.command.terminal === 'captured') {
      throw Object.assign(
        new Error('captured command must run through /api/commands/run'),
        { statusCode: 400 }
      );
    }
    if (this.saveService) {
      await this.saveService.assertStepCommand(tutorial, step, {
        generation,
        requireEditable: commandSpec.command.type === 'test',
      });
    }
    if (completionToken) {
      this.saveService?.beginCommand?.({
        tutorial,
        step,
        generation,
        token: completionToken,
      });
    }

    try {
      const remoteScript = ensured.session.tempScriptPath(step, command);
      await ensured.session.uploadScript(commandSpec.script, remoteScript);
      hooks.onOutput?.(`\x1b[90m$ bash ${commandSpec.command.script || remoteScript}\x1b[0m\r\n`);
      const handle = await ensured.session.attachCommand(remoteScript, {
        onOutput: hooks.onOutput,
        onDone: (exitCode) => {
          this.saveService?.finishCommand?.(completionToken);
          hooks.onDone?.(exitCode);
        },
      });
      return {
        command,
        kernel: auth?.kernel ? { id: auth.kernel.id, provider: auth.kernel.provider } : undefined,
        handle,
      };
    } catch (error) {
      this.saveService?.finishCommand?.(completionToken);
      throw error;
    }
  }

  async authorizeCommand({ tutorial }) {
    if (!this.securityPolicyService) return null;
    return this.securityPolicyService.authorizeCommand({ tutorial });
  }

  async ensureRuntime(auth) {
    if (this.runtimeManager && auth?.kernel) {
      return this.runtimeManager.ensureForKernel(auth.kernel);
    }
    if (this.runtimeManager) {
      return {
        session: this.runtimeManager.getSession(),
        kernel: this.runtimeManager.getActiveKernel(),
        replaced: false,
      };
    }
    return {
      session: this.runtimeSession,
      kernel: auth?.kernel || null,
      replaced: false,
    };
  }

  async ensureRuntimeSession(auth) {
    const ensured = await this.ensureRuntime(auth);
    return ensured.session;
  }
}
