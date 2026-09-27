/**
 * Player-host platform facts. The lab machine is separate: Linux this-computer
 * when the player itself is Linux; otherwise the student connects a lab over SSH.
 */

export const WINDOWS_SSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

export function localLabSupported(platform = process.platform) {
  return platform === 'linux';
}

export function describePlayer(platform = process.platform) {
  return {
    platform,
    local_lab_supported: localLabSupported(platform),
  };
}

export function defaultSshAgent(env = process.env, platform = process.platform) {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform === 'win32') return WINDOWS_SSH_AGENT_PIPE;
  return null;
}
