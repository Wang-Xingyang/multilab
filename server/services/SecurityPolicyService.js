export class SecurityPolicyService {
  constructor({ packageService, trustStore, kernelRegistry, kernelSelectionStore = null }) {
    this.packageService = packageService;
    this.trustStore = trustStore;
    this.kernelRegistry = kernelRegistry;
    this.kernelSelectionStore = kernelSelectionStore;
  }

  async authorizeCommand({ tutorial }) {
    const { cfg, packageDigest } = await this.packageService.loadTutorialConfig(tutorial);
    const pkg = {
      ...cfg,
      version: cfg.version || '0.0.0',
      schema_version: cfg.schema_version || 0,
      package_digest: packageDigest,
    };
    const trust = await this.trustStore.getPackageTrust(packageDigest);
    const preferredKernelId = this.kernelSelectionStore
      ? await this.kernelSelectionStore.getPreferredKernel(packageDigest)
      : null;
    const resolution = this.kernelRegistry.resolveForPackage(pkg, { preferredKernelId });
    const selectedKernel = resolution.selected;

    if (!selectedKernel) {
      throw Object.assign(
        new Error('No compatible kernel found for this package'),
        { statusCode: 409 }
      );
    }

    const security = pkg.security || {};
    const sandboxRequired = security.sandbox_required === true || trust.trust === 'untrusted';
    if (sandboxRequired && !(selectedKernel.capabilities || []).includes('sandbox')) {
      throw Object.assign(
        new Error('Package requires a sandbox-capable kernel before commands can run'),
        { statusCode: 403 }
      );
    }

    const networkRequired = security.network_required === true;
    if (!networkRequired && selectedKernel.network_default !== 'none') {
      throw Object.assign(
        new Error('Package requires network-disabled execution before commands can run'),
        { statusCode: 403 }
      );
    }
    if (networkRequired && selectedKernel.network_default === 'none') {
      throw Object.assign(
        new Error('Package requires network access, but the selected kernel does not allow it'),
        { statusCode: 409 }
      );
    }

    return {
      package: pkg,
      trust,
      kernel: selectedKernel,
      resolution,
    };
  }
}
