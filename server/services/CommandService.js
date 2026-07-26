import { validateSafePath } from './PackageService.js';

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

  async runCapturedCommand({ tutorial, step, command }) {
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

    const remoteScript = remoteCommandPath(step, command);
    await session.uploadScript(commandSpec.script, remoteScript);
    const result = await session.runCaptured(remoteScript);
    const passed = result.exitCode === 0;
    const progress = commandSpec.command.type === 'test' && this.saveService
      ? await this.saveService.recordTestResult(tutorial, step, passed)
      : null;
    return {
      command,
      exitCode: result.exitCode,
      passed,
      output: (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim(),
      kernel: auth?.kernel ? { id: auth.kernel.id, provider: auth.kernel.provider } : undefined,
      ...(progress ? { progress } : {}),
    };
  }

  async runInteractiveCommand({ tutorial, step, command, terminal }) {
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

    const remoteScript = remoteCommandPath(step, command);
    await ensured.session.uploadScript(commandSpec.script, remoteScript);
    terminal.runScript(remoteScript);
    return {
      command,
      kernel: auth?.kernel ? { id: auth.kernel.id, provider: auth.kernel.provider } : undefined,
    };
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

function remoteCommandPath(stepId, commandId) {
  return `/tmp/${validateSafePath(stepId)}.${validateSafePath(commandId)}.sh`;
}

