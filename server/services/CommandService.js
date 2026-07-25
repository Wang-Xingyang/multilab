import { validateSafePath } from './PackageService.js';

export class CommandService {
  constructor({ packageService, runtimeSession }) {
    this.packageService = packageService;
    this.runtimeSession = runtimeSession;
  }

  async runCapturedCommand({ tutorial, step, command }) {
    validateSafePath(tutorial);
    validateSafePath(step);
    validateSafePath(command);

    const commandSpec = await this.packageService.getStepCommandScript(tutorial, step, command);
    if (commandSpec.command.terminal === 'interactive') {
      throw Object.assign(
        new Error('interactive command must run through WebSocket terminal'),
        { statusCode: 400 }
      );
    }

    const remoteScript = remoteCommandPath(step, command);
    await this.runtimeSession.uploadScript(commandSpec.script, remoteScript);
    const result = await this.runtimeSession.runCaptured(remoteScript);
    return {
      command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      output: (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim(),
    };
  }

  async runInteractiveCommand({ tutorial, step, command, terminal }) {
    validateSafePath(tutorial);
    validateSafePath(step);
    validateSafePath(command);

    const commandSpec = await this.packageService.getStepCommandScript(tutorial, step, command);
    if (commandSpec.command.terminal === 'captured') {
      throw Object.assign(
        new Error('captured command must run through /api/commands/run'),
        { statusCode: 400 }
      );
    }

    const remoteScript = remoteCommandPath(step, command);
    await this.runtimeSession.uploadScript(commandSpec.script, remoteScript);
    terminal.runScript(remoteScript);
    return { command };
  }
}

function remoteCommandPath(stepId, commandId) {
  return `/tmp/${validateSafePath(stepId)}.${validateSafePath(commandId)}.sh`;
}

