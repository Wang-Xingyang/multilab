export class KernelRegistry {
  constructor({ kernels }) {
    this.kernels = kernels;
  }

  listKernels() {
    return this.kernels.map(kernel => ({ ...kernel }));
  }

  resolveForPackage(pkg) {
    const requirements = pkg.runtime_requirements || {};
    const candidates = this.kernels
      .map(kernel => ({
        kernel,
        match: kernelMatchesRequirements(kernel, requirements),
        recommended: Boolean(pkg.recommended_kernel && kernel.id === pkg.recommended_kernel),
      }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));

    const selected = candidates.find(candidate => candidate.recommended && candidate.match.ok)
      || candidates.find(candidate => candidate.match.ok)
      || null;

    return {
      selected: selected ? selected.kernel : null,
      candidates: candidates.map(candidate => ({
        ...candidate.kernel,
        recommended: candidate.recommended,
        compatible: candidate.match.ok,
        missing_capabilities: candidate.match.missingCapabilities,
        missing_commands: candidate.match.missingCommands,
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
          gcc: true,
          gdb: true,
          bash: true,
          make: true,
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
  const platformOk = !requirements.platform || requirements.platform === kernel.platform;

  return {
    ok: platformOk && missingCapabilities.length === 0 && missingCommands.length === 0,
    missingCapabilities,
    missingCommands,
  };
}

