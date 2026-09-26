import os from 'os';
import path from 'path';

export const LOCAL_WORKSPACE_LINK = path.join(os.homedir(), '.multilab', 'workspace');
export const LOCAL_SHELL_PID_DIR = path.join(os.homedir(), '.multilab', 'shells');
export const LOCAL_WORKSPACE_GEN = path.join(os.homedir(), '.multilab', 'ws-gen');
export const CANONICAL_WORKSPACE = '/home/student/workspace';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function posixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

/** Prompt shows ~/workspace while cwd is the MultiLab workspace link. */
export function localPromptCommand(workspace = LOCAL_WORKSPACE_LINK) {
  const ws = posixPath(workspace);
  const q = shellQuote(ws);
  return [
    'p="$PWD"',
    `t=$(readlink -f ${q} 2>/dev/null || true)`,
    `if [ "$p" = ${q} ] || { [ -n "$t" ] && [ "$p" = "$t" ]; }; then printf %s "~/workspace"`,
    `elif [[ "$p" == ${q}/* ]]; then printf %s "~/workspace/\${p#${ws}/}"`,
    `elif [ -n "$t" ] && [[ "$p" == "$t"/* ]]; then printf %s "~/workspace/\${p#$t/}"`,
    `elif [ "$p" = "$HOME" ]; then printf %s "~"`,
    `elif [[ "$p" == "$HOME"/* ]]; then printf %s "~\${p#$HOME}"`,
    'else printf %s "$p"; fi',
  ].join('; ');
}

export function localShellEnv({
  workspace = LOCAL_WORKSPACE_LINK,
  home = os.homedir(),
} = {}) {
  const ps1 = [
    '\\[\\e[01;32m\\]\\u@\\h\\[\\e[00m\\]:\\[\\e[01;34m\\]',
    `$(${localPromptCommand(workspace)})`,
    '\\[\\e[00m\\]$ ',
  ].join('');
  return {
    ...process.env,
    HOME: home,
    TERM: process.env.TERM || 'xterm-256color',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    MULTILAB_WORKSPACE: posixPath(workspace),
    PS1: ps1,
  };
}

export function localRcFileContents({
  workspace = LOCAL_WORKSPACE_LINK,
  home = os.homedir(),
  pidDir = LOCAL_SHELL_PID_DIR,
  genFile = LOCAL_WORKSPACE_GEN,
} = {}) {
  const ws = shellQuote(posixPath(workspace));
  const gen = shellQuote(posixPath(genFile));
  const pids = shellQuote(posixPath(pidDir));
  const bashrc = shellQuote(path.join(home, '.bashrc'));
  const env = localShellEnv({ workspace, home });
  return `# MultiLab this-computer shell
[ -f ${bashrc} ] && . ${bashrc}
PS1=${shellQuote(env.PS1)}
export MULTILAB_WORKSPACE=${ws}
MULTILAB_WS_GEN_SEEN=
multilab_reenter_workspace() {
  local old="\${OLDPWD-}"
  cd / && cd -L ${ws} >/dev/null 2>&1 || return 0
  if [ -n "$old" ]; then OLDPWD="$old"; fi
}
multilab_sync_workspace() {
  [ -n "\${MULTILAB_WS_SYNCING-}" ] && return 0
  MULTILAB_WS_SYNCING=1
  local gen
  gen=$(cat ${gen} 2>/dev/null || true)
  if [ "$gen" != "$MULTILAB_WS_GEN_SEEN" ]; then
    MULTILAB_WS_GEN_SEEN=$gen
    multilab_reenter_workspace
  fi
  MULTILAB_WS_SYNCING=
}
mkdir -p ${pids} 2>/dev/null || true
echo $$ > ${pids}/$$ 2>/dev/null || true
trap 'multilab_sync_workspace' USR1
trap "rm -f ${pids}/\$\$" EXIT
trap 'multilab_sync_workspace' DEBUG
multilab_reenter_workspace
PROMPT_COMMAND="multilab_sync_workspace\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
`;
}

export function signalLocalShellsScript(pidDir = LOCAL_SHELL_PID_DIR) {
  const dir = posixPath(pidDir);
  return `
for f in ${shellQuote(dir)}/*; do
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

/** Existing tutorials hardcode the Docker workspace path; rewrite for this computer. */
export function rewriteCanonicalWorkspace(script, workspace = LOCAL_WORKSPACE_LINK) {
  return String(script || '').split(CANONICAL_WORKSPACE).join(posixPath(workspace));
}
