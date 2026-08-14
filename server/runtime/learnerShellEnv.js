/**
 * Interactive-shell environment for learners.
 *
 * The physical save tree lives under /home/student/.mlab-saves and must never
 * appear in the prompt. Bash \w follows $PWD, and Docker WorkingDir of a
 * symlink is the physical target — so PS1 cannot use \w as-is.
 */

export const LEARNER_HOME = '/home/student';
export const LEARNER_WORKSPACE = '/home/student/workspace';
export const LEARNER_SAVES = '/home/student/.mlab-saves';

/** Map a physical or logical cwd to the path shown in the prompt. */
export function displayLearnerPath(pwd, {
  home = LEARNER_HOME,
  workspace = LEARNER_WORKSPACE,
  saves = LEARNER_SAVES,
} = {}) {
  const p = String(pwd || '');
  if (p === workspace) return '~/workspace';
  if (p.startsWith(`${workspace}/`)) return `~${p.slice(home.length)}`;
  if (p === saves || p.startsWith(`${saves}/`)) {
    const marker = '/files';
    const idx = p.indexOf(marker);
    if (idx !== -1) {
      const rest = p.slice(idx + marker.length);
      return rest ? `~/workspace${rest}` : '~/workspace';
    }
  }
  if (p === home) return '~';
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * Env vars for the interactive learner bash.
 * PS1 hides the save-tree physical path even when $PWD is unresolved.
 */
export function learnerShellEnv() {
  const stripHome = `\${p#${LEARNER_HOME}}`;
  const afterFiles = '${p#*/files/}';
  const ps1 = [
    '\\[\\e[01;32m\\]\\u@\\h\\[\\e[00m\\]:\\[\\e[01;34m\\]',
    '$(p="$PWD";',
    `if [[ "$p" == "${LEARNER_WORKSPACE}" ]]; then printf %s "~/workspace";`,
    `elif [[ "$p" == "${LEARNER_WORKSPACE}/"* ]]; then printf %s "~${stripHome}";`,
    `elif [[ "$p" == "${LEARNER_SAVES}/"*"/files" ]]; then printf %s "~/workspace";`,
    `elif [[ "$p" == "${LEARNER_SAVES}/"*"/files/"* ]]; then printf %s "~/workspace/${afterFiles}";`,
    `elif [[ "$p" == "${LEARNER_HOME}" ]]; then printf %s "~";`,
    `elif [[ "$p" == "${LEARNER_HOME}/"* ]]; then printf %s "~${stripHome}";`,
    'else printf %s "$p"; fi)',
    '\\[\\e[00m\\]$ ',
  ].join('');
  return [
    `HOME=${LEARNER_HOME}`,
    `PS1=${ps1}`,
    'TERM=xterm-256color',
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
  ];
}

/** Login-shell snippet: cd into the logical workspace so pwd matches the prompt. */
export function learnerProfileSnippet() {
  return `# MultiLab: keep the learner shell on the logical workspace path.
cd -L ${LEARNER_WORKSPACE} 2>/dev/null || true
`;
}
