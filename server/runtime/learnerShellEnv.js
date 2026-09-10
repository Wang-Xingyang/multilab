/**
 * Interactive-shell environment for learners.
 *
 * The physical save tree lives under /mlab/saves (outside $HOME) and must
 * never appear in the prompt. Bash \w follows $PWD, and Docker WorkingDir of
 * a symlink is the physical target — so PS1 cannot use \w as-is.
 */

import {
  DEFAULT_WORKSPACE_LOCATION,
  LEGACY_SAVES_BIND_TARGET,
  SAVES_BIND_TARGET,
} from '../workspace/WorkspaceStrategy.js';

export const LEARNER_HOME = '/home/student';
export const LEARNER_WORKSPACE = DEFAULT_WORKSPACE_LOCATION;
export const LEARNER_SAVES = SAVES_BIND_TARGET;
export const LEARNER_SAVES_LEGACY = LEGACY_SAVES_BIND_TARGET;
export const LEARNER_SHELL_PID_DIR = '/tmp/multilab-shells';
export const WORKSPACE_IDLE = '/tmp/mlab-workspace-idle';
export const WORKSPACE_GEN_FILE = '/tmp/multilab-ws-gen';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hideSaveTree(pwd, saves, workspace, home) {
  const p = String(pwd || '');
  if (p === saves || p.startsWith(`${saves}/`)) {
    const marker = '/files';
    const idx = p.indexOf(marker);
    if (idx !== -1) {
      const rest = p.slice(idx + marker.length);
      return rest ? `${workspace.replace(home, '~')}${rest}` : '~/workspace';
    }
  }
  return null;
}

/** Map a physical or logical cwd to the path shown in the prompt. */
export function displayLearnerPath(pwd, {
  home = LEARNER_HOME,
  workspace = LEARNER_WORKSPACE,
  saves = LEARNER_SAVES,
} = {}) {
  const p = String(pwd || '');
  if (p === workspace) return '~/workspace';
  if (p.startsWith(`${workspace}/`)) return `~${p.slice(home.length)}`;
  const hidden = hideSaveTree(p, saves, workspace, home)
    || hideSaveTree(p, LEARNER_SAVES_LEGACY, workspace, home);
  if (hidden) return hidden;
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
    `elif [[ "$p" == "${LEARNER_SAVES}/"*"/files" || "$p" == "${LEARNER_SAVES_LEGACY}/"*"/files" ]]; then printf %s "~/workspace";`,
    `elif [[ "$p" == "${LEARNER_SAVES}/"*"/files/"* || "$p" == "${LEARNER_SAVES_LEGACY}/"*"/files/"* ]]; then printf %s "~/workspace/${afterFiles}";`,
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

export function reenterWorkspaceCommand(workspace = LEARNER_WORKSPACE) {
  return `cd / && cd -L ${workspace}`;
}

/**
 * Keep /home/student/workspace as a symlink. A real directory there is the
 * image WORKDIR; rmdir/replace while bash has that cwd leaves a deleted
 * inode ("No such file or directory") and later `touch` writes nowhere useful.
 */
export function repairWorkspaceCwdScript({
  workspace = LEARNER_WORKSPACE,
  idle = WORKSPACE_IDLE,
  saves = LEARNER_SAVES,
} = {}) {
  const ws = shellQuote(workspace);
  const idleDir = shellQuote(idle);
  const savesDir = shellQuote(saves);
  return `
set -e
mkdir -p ${savesDir} ${idleDir}
chmod 777 ${idleDir}
if [ -L ${ws} ] && [ ! -e ${ws} ]; then
  rm -f ${ws}
fi
if [ -d ${ws} ] && [ ! -L ${ws} ]; then
  aside=${ws}.mlab-aside-$$
  mv ${ws} "$aside"
  rm -rf "$aside" || true
fi
if [ ! -e ${ws} ]; then
  ln -sfn ${idleDir} ${ws}
fi
`;
}

/**
 * Replace the workspace symlink in place. Do not `rm` the link first: that
 * window makes `touch` fail with a missing cwd. `ln -sfn` replaces a symlink;
 * a leftover real directory is moved aside first.
 */
export function retargetWorkspaceScript(targetPath, {
  workspace = LEARNER_WORKSPACE,
  genFile = WORKSPACE_GEN_FILE,
} = {}) {
  const ws = shellQuote(workspace);
  const target = shellQuote(targetPath);
  const gen = shellQuote(genFile);
  return `
set -e
mkdir -p ${target}
date +%s%N > ${gen} 2>/dev/null || echo $$ > ${gen}
chmod 644 ${gen} 2>/dev/null || true
if [ -d ${ws} ] && [ ! -L ${ws} ]; then
  aside=${ws}.mlab-aside-$$
  mv ${ws} "$aside"
fi
ln -sfn ${target} ${ws}
rm -rf ${ws}.mlab-aside-$$ 2>/dev/null || true
`;
}

/**
 * Signal only shells that registered a pid file (they installed the USR1 trap).
 * Never fake-type `cd` into the learner TTY — readline would echo it.
 */
export function signalAttachedShellsScript(pidDir = LEARNER_SHELL_PID_DIR) {
  return `
for f in ${pidDir}/*; do
  [ -f "$f" ] || continue
  pid=$(basename "$f")
  case "$pid" in
    *[!0-9]*) rm -f "$f"; continue ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    kill -USR1 "$pid" 2>/dev/null || true
  else
    rm -f "$f"
  fi
done
`;
}

/**
 * Login-shell snippet: stay on the logical workspace path. After a step
 * retarget, `cd -L $PWD` is a no-op because bash still thinks it is already
 * there — bounce through `/` so the new symlink target is used.
 *
 * Open shells are told to re-enter via SIGUSR1 (the process must chdir
 * itself). Do not write commands into the TTY.
 */
export function learnerProfileSnippet() {
  const bounce = reenterWorkspaceCommand();
  return `# MultiLab: keep the learner shell on the logical workspace path.
[ -n "\${MULTILAB_SHELL_HOOK-}" ] && return 0
MULTILAB_SHELL_HOOK=1
MULTILAB_WS_GEN_SEEN=
multilab_reenter_workspace() {
  local old="\${OLDPWD-}"
  ${bounce} >/dev/null 2>&1 || return 0
  if [ -n "$old" ]; then OLDPWD="$old"; fi
}
multilab_sync_workspace() {
  [ -n "\${MULTILAB_WS_SYNCING-}" ] && return 0
  MULTILAB_WS_SYNCING=1
  local gen
  gen=$(cat ${WORKSPACE_GEN_FILE} 2>/dev/null || true)
  if [ "$gen" != "$MULTILAB_WS_GEN_SEEN" ]; then
    MULTILAB_WS_GEN_SEEN=$gen
    multilab_reenter_workspace
  fi
  MULTILAB_WS_SYNCING=
}
mkdir -p ${LEARNER_SHELL_PID_DIR} 2>/dev/null || true
chmod 700 ${LEARNER_SHELL_PID_DIR} 2>/dev/null || true
echo $$ > "${LEARNER_SHELL_PID_DIR}/$$" 2>/dev/null || true
trap 'multilab_sync_workspace' USR1
trap 'rm -f "${LEARNER_SHELL_PID_DIR}/$$"' EXIT
trap 'multilab_sync_workspace' DEBUG
multilab_reenter_workspace
PROMPT_COMMAND="multilab_sync_workspace\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
`;
}
