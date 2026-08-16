import { state, currentStepObj, currentTutorialKey, stepCommand } from './state.js';
import { apiJson } from './api.js';
import { toast, status } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { handleError } from './errors.js';
import {
  applyProgress,
  showTestResults,
  showPreviewContent,
  revealAuxPanel,
} from './panels.js';
import { saveCurrentStep, refreshFileTree } from './files.js';

export async function runCode() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast(t('commands.wsDisconnected'), true);
    return;
  }
  if (!state.currentTutorial) return;
  try {
    await saveCurrentStep({ silent: true, force: true });
  } catch (e) {
    handleError(e, {
      feature: 'commands',
      message: t('commands.saveBeforeRunFailed', { error: e.message }),
      notify: true,
    });
    return;
  }
  const step = currentStepObj();
  const command = stepCommand(step, 'run');
  if (!command) {
    toast(t('commands.noRunCommand'), true);
    return;
  }
  state.ws.send(JSON.stringify({
    type: 'command',
    tutorial: currentTutorialKey(),
    step: step.id,
    command: command.id || command.type,
  }));
}

export async function runTest() {
  const step = currentStepObj();
  const command = stepCommand(step, 'test');
  if (!state.currentTutorial || !command) return;
  try {
    await saveCurrentStep({ silent: true, force: true });
    const res = await apiJson('/api/commands/run', {
      tutorial: currentTutorialKey(),
      step: step.id,
      command: command.id || command.type,
    });
    const color = res.passed ? '\x1b[32m' : '\x1b[31m';
    state.term.write(`\r\n${color}[${res.passed ? 'PASS' : 'FAIL'}]\x1b[0m\r\n${res.output || ''}\r\n`);
    applyProgress(res.progress);
    showTestResults(res);
    appendSessionLog(
      res.passed ? t('commands.testPassedLog', { id: step.id }) : t('commands.testFailedLog', { id: step.id }),
      res.passed ? 'info' : 'warn'
    );
    toast(res.passed ? t('commands.testPassed') : t('commands.testFailed'), !res.passed);
    refreshFileTree(false);
  } catch (e) {
    handleError(e, {
      feature: 'commands',
      message: t('commands.testError', { error: e.message }),
      notify: true,
    });
  }
}

export async function runPreview() {
  const step = currentStepObj();
  const command = stepCommand(step, 'preview');
  if (!state.currentTutorial || !command) return;
  try {
    await saveCurrentStep({ silent: true, force: true });
    if (command.terminal === 'interactive') {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        toast(t('commands.wsDisconnected'), true);
        return;
      }
      state.ws.send(JSON.stringify({
        type: 'command',
        tutorial: currentTutorialKey(),
        step: step.id,
        command: command.id || command.type,
      }));
      document.getElementById('pane-web-preview').innerHTML =
        `<div class="aux-empty"><span>${t('commands.previewInteractiveHint')}</span></div>`;
      revealAuxPanel('web-preview');
      toast(t('commands.previewStarted'));
      return;
    }
    status(t('commands.previewing'));
    const res = await apiJson('/api/commands/run', {
      tutorial: currentTutorialKey(),
      step: step.id,
      command: command.id || command.type,
    });
    await showPreviewContent(res);
    toast(
      res.passed === false ? t('commands.previewCommandFailed') : t('commands.previewUpdated'),
      res.passed === false
    );
    refreshFileTree(false);
  } catch (e) {
    handleError(e, {
      feature: 'commands',
      message: t('commands.previewFailed', { error: e.message }),
      notify: true,
    });
  }
}
