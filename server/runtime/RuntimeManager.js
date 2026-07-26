export class RuntimeManager {
  constructor({ providers = {}, kernelRegistry, packageService = null }) {
    this.providers = { ...providers };
    this.kernelRegistry = kernelRegistry;
    this.packageService = packageService;
    this.activeKernel = null;
    this.activeSession = null;
    this.activeFingerprint = null;
  }

  registerProvider(provider) {
    if (!provider?.kind) {
      throw new Error('RuntimeProvider must declare kind');
    }
    this.providers[provider.kind] = provider;
  }

  listProviders() {
    return Object.values(this.providers).map(provider => ({
      id: provider.id,
      kind: provider.kind,
    }));
  }

  getProviderForKernel(kernel) {
    if (!kernel?.provider) {
      throw Object.assign(new Error('kernel missing provider'), { statusCode: 409 });
    }
    const provider = this.providers[kernel.provider];
    if (!provider) {
      throw Object.assign(
        new Error(`No runtime provider registered for kind: ${kernel.provider}`),
        { statusCode: 409, code: 'provider_missing', provider: kernel.provider }
      );
    }
    return provider;
  }

  getSession() {
    if (!this.activeSession) {
      throw Object.assign(new Error('runtime session is not ready'), { statusCode: 503 });
    }
    return this.activeSession;
  }

  getActiveKernel() {
    return this.activeKernel ? { ...this.activeKernel } : null;
  }

  async ensureDefaultSession() {
    const kernels = this.kernelRegistry.listKernels();
    if (!kernels.length) {
      throw new Error('No kernels registered');
    }
    return this.ensureForKernel(kernels[0]);
  }

  async ensureForTutorial(tutorialKey) {
    if (!this.packageService) {
      throw new Error('RuntimeManager requires packageService to resolve tutorials');
    }
    const { cfg, packageDigest } = await this.packageService.loadTutorialConfig(tutorialKey);
    const pkg = {
      ...cfg,
      version: cfg.version || '0.0.0',
      package_digest: packageDigest,
    };
    const resolution = this.kernelRegistry.resolveForPackage(pkg);
    if (!resolution.selected) {
      throw Object.assign(new Error('No compatible kernel found for this package'), {
        statusCode: 409,
        code: 'kernel_missing',
      });
    }
    return this.ensureForKernel(resolution.selected);
  }

  async ensureForKernel(kernel) {
    const provider = this.getProviderForKernel(kernel);
    const plan = provider.planKernelSession
      ? provider.planKernelSession(kernel)
      : { fingerprint: `${kernel.provider}:${kernel.id}`, kernel };

    if (
      this.activeSession
      && this.activeKernel?.id === kernel.id
      && this.activeFingerprint === plan.fingerprint
    ) {
      await this.activeSession.ensure();
      return {
        session: this.activeSession,
        kernel: this.activeKernel,
        provider,
        replaced: false,
        plan,
      };
    }

    if (typeof provider.applyKernel === 'function') {
      await provider.applyKernel(kernel);
    }

    const session = await provider.startSession();
    const replaced = Boolean(
      this.activeKernel && (
        this.activeKernel.id !== kernel.id || this.activeFingerprint !== plan.fingerprint
      )
    );

    this.activeKernel = { ...kernel };
    this.activeSession = session;
    this.activeFingerprint = plan.fingerprint;

    return {
      session,
      kernel: this.activeKernel,
      provider,
      replaced,
      plan,
    };
  }
}
