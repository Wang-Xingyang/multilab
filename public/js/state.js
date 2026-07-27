/** Shared mutable UI/runtime state for no-bundler modules. */
const EMPTY_PROGRESS = { current_step: null, visited: [], test_passed: {}, updated_at: null };

export const state = {
  ws: null,
  editor: null,
  term: null,
  fitAddon: null,
  currentTutorial: null,
  currentStep: 0,
  currentProgress: EMPTY_PROGRESS,
  theme: (typeof localStorage !== 'undefined' && localStorage.getItem('multilab-theme')) || 'dark',
  currentFiles: [],
  activeFileIndex: 0,
  fileModified: [],
  suppressModified: false,
  stepLoadSeq: 0,
  fileListCache: null,
  fileListFetching: false,
  auxVisible: false,
  activeAuxTab: 'test-results',
  wsForceClose: false,
  wsReconnectTimer: null,
  fileTreeFetching: false,
  fileTreeActivePath: null,
};

export const FALLBACK_PANELS = [
  { id: 'tutorial', type: 'tutorial', area: 'left' },
  { id: 'editor', type: 'editor', area: 'center' },
  { id: 'terminal', type: 'terminal', area: 'bottom' },
];

export const AUX_PANEL_TYPES = ['test-results', 'web-preview', 'logs', 'diagnostics'];

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

export function stepCommand(step, type) {
  return (step?.commands || []).find(
    cmd => (cmd.type === type || cmd.id === type) && cmd.available !== false
  ) || null;
}
