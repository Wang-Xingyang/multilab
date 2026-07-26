export class KernelRegistry {
  constructor({ kernels }) {
    this.kernels = kernels;
  }

  listKernels() {
    return this.kernels.map(kernel => ({ ...kernel }));
  }

  resolveForPackage(pkg, { preferredKernelId = null } = {}) {
    const requirements = pkg.runtime_requirements || {};
    const candidates = this.kernels
      .map(kernel => ({
        kernel,
        match: kernelMatchesRequirements(kernel, requirements),
        recommended: Boolean(pkg.recommended_kernel && kernel.id === pkg.recommended_kernel),
      }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));

    const preferred = preferredKernelId
      ? candidates.find(candidate => candidate.kernel.id === preferredKernelId && candidate.match.ok)
      : null;
    const selected = preferred
      || candidates.find(candidate => candidate.recommended && candidate.match.ok)
      || candidates.find(candidate => candidate.match.ok)
      || null;

    return {
      selected: selected ? selected.kernel : null,
      preferred_kernel_id: preferredKernelId || null,
      preferred_applied: Boolean(preferred),
      candidates: candidates.map(candidate => ({
        ...candidate.kernel,
        recommended: candidate.recommended,
        compatible: candidate.match.ok,
        missing_capabilities: candidate.match.missingCapabilities,
        missing_commands: candidate.match.missingCommands,
        version_mismatches: candidate.match.versionMismatches,
      })),
      requirements,
    };
  }
}

export function createDefaultKernelRegistry({ image, workspaceDir }) {
  return new KernelRegistry({
    kernels: [
      {
        id: 'gcc-ubuntu24-docker',
        display_name: 'GCC Ubuntu 24.04 (Docker)',
        provider: 'docker',
        image,
        user: 'student',
        workspace: workspaceDir,
        platform: 'linux',
        capabilities: ['tty', 'compile', 'debug', 'signals', 'sandbox'],
        commands: {
          gcc: '13.3.0',
          gdb: '15.0.0',
          bash: '5.2.0',
          make: '4.3.0',
        },
        sandbox_presets: ['standard'],
        network_default: 'none',
      },
    ],
  });
}

function kernelMatchesRequirements(kernel, requirements) {
  const requiredCapabilities = Array.isArray(requirements.capabilities) ? requirements.capabilities : [];
  const requiredCommands = requirements.commands && typeof requirements.commands === 'object'
    ? Object.keys(requirements.commands)
    : [];

  const missingCapabilities = requiredCapabilities.filter(capability => !(kernel.capabilities || []).includes(capability));
  const missingCommands = requiredCommands.filter(command => !kernel.commands?.[command]);
  const versionMismatches = requiredCommands
    .filter(command => kernel.commands?.[command] && requirements.commands?.[command])
    .map(command => {
      const required = requirements.commands[command];
      const found = kernel.commands[command];
      if (commandVersionSatisfies(found, required)) return null;
      return { command, required, found };
    })
    .filter(Boolean);
  const platformOk = !requirements.platform || requirements.platform === kernel.platform;

  return {
    ok: platformOk
      && missingCapabilities.length === 0
      && missingCommands.length === 0
      && versionMismatches.length === 0,
    missingCapabilities,
    missingCommands,
    versionMismatches,
  };
}

function commandVersionSatisfies(found, required) {
  if (required === true || required === '' || required == null) return true;
  if (found === true) return true;
  if (typeof found !== 'string') return false;
  const constraint = String(required).trim();
  if (!constraint || constraint === '*') return true;
  const match = constraint.match(/^(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+){0,3})$/);
  if (!match) return true;
  const op = match[1] || '=';
  const cmp = compareVersions(found, match[2]);
  if (op === '>=') return cmp >= 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  return cmp === 0;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(version) {
  const match = String(version).match(/[0-9]+(?:\.[0-9]+){0,3}/);
  if (!match) return [0];
  return match[0].split('.').map(part => Number(part));
}

