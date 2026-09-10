/** Shared mutable UI/runtime state for no-bundler modules. */
export const EMPTY_PROGRESS = {
  current_step: null,
  visited: [],
  test_passed: {},
  test_hash: {},
  completed: {},
  editable: {},
  entered_editable: {},
  updated_at: null,
};

export const EMPTY_STEP_ACCESS = {
  editable: false,
  needs_edit: true,
  has_solution: false,
  complete: false,
  commands_allowed: false,
  generation: null,
};

export const state = {
  ws: null,
  editor: null,
  term: null,
  fitAddon: null,
  currentTutorial: null,
  currentStep: 0,
  currentProgress: EMPTY_PROGRESS,
  currentStepAccess: { ...EMPTY_STEP_ACCESS },
  commandBusy: false,
  theme: (typeof localStorage !== 'undefined' && localStorage.getItem('multilab-theme')) || 'dark',
  currentFiles: [],
  activeFileIndex: 0,
  fileModified: [],
  suppressModified: false,
  stepLoadSeq: 0,
  fileListCache: null,
  fileListFetching: false,
  openViewTabs: [],
  activeViewId: null,
  wsForceClose: false,
  wsReconnectTimer: null,
  fileTreeFetching: false,
  fileTreeActivePath: null,
  fileTreeCollapsed: false,
  tutorialCollapsed: (typeof localStorage !== 'undefined' && localStorage.getItem('ml-tutorial-collapsed') === '1'),
  previewForcedOpen: false,
};

export const FALLBACK_PANELS = [
  { id: 'tutorial', type: 'tutorial', area: 'left' },
  { id: 'files', type: 'file-tree', area: 'center-right' },
  { id: 'editor', type: 'editor', area: 'center' },
  { id: 'terminal', type: 'terminal', area: 'bottom' },
];

export const TERM_THEME = {
  dark: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78',
    black: '#000000', red: '#f48771', green: '#4ec9b0', yellow: '#dcdcaa',
    blue: '#569cd6', magenta: '#c586c0', cyan: '#4ec9b0', white: '#d4d4d4',
    brightBlack: '#808080', brightRed: '#f48771', brightGreen: '#4ec9b0', brightYellow: '#dcdcaa',
    brightBlue: '#569cd6', brightMagenta: '#c586c0', brightCyan: '#4ec9b0', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e', selectionBackground: '#add6ff',
    black: '#000000', red: '#d73a49', green: '#098658', yellow: '#b58900',
    blue: '#0066b8', magenta: '#800080', cyan: '#0086a0', white: '#555555',
    brightBlack: '#666666', brightRed: '#a31515', brightGreen: '#098658', brightYellow: '#b58900',
    brightBlue: '#0066b8', brightMagenta: '#800080', brightCyan: '#0086a0', brightWhite: '#1e1e1e',
  },
};

export function currentStepObj() {
  return state.currentTutorial?.steps?.[state.currentStep] || null;
}

export function currentTutorialKey() {
  return state.currentTutorial?.source_key || state.currentTutorial?.id;
}

export function stepAccessWritable() {
  return Boolean(state.currentStepAccess?.editable) && !state.commandBusy;
}

export function previousStepsComplete() {
  const steps = state.currentTutorial?.steps || [];
  const idx = state.currentStep;
  const completed = state.currentProgress?.completed || {};
  for (let i = 0; i < idx; i++) {
    if (!completed[steps[i]?.id]) return false;
  }
  return true;
}

export function stepCommandsAllowed() {
  if (state.commandBusy) return false;
  if (state.currentStepAccess?.needs_edit === false) return true;
  if (!state.currentStepAccess?.editable) return false;
  if (state.currentStepAccess?.commands_allowed === false) return false;
  return previousStepsComplete();
}

export function stepShellInputAllowed() {
  if (state.commandBusy) return true;
  if (state.currentStepAccess?.needs_edit === false) return false;
  return stepCommandsAllowed();
}

export function stepCommandEnabled(type) {
  if (type === 'interrupt') return Boolean(state.commandBusy);
  if (state.commandBusy) return false;
  if (state.currentStepAccess?.needs_edit === false) return type === 'preview';
  return stepCommandsAllowed();
}

export function stepCommand(step, type) {
  return (step?.commands || []).find(
    cmd => (cmd.type === type || cmd.id === type) && cmd.available !== false
  ) || null;
}
