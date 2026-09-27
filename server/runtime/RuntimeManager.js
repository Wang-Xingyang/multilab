import { describeRuntimeInternalStrategy } from '../workspace/WorkspaceStrategy.js';

export class RuntimeManager {
  constructor({ providers = {}, kernelRegistry, packageService = null, kernelSelectionStore = null }) {
    this.providers = { ...providers };
    this.kernelRegistry = kernelRegistry;
    this.packageService = packageService;
    this.kernelSelectionStore = kernelSelectionStore;
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
      capabilities: typeof provider.capabilities === 'function'
        ? provider.capabilities()
        : null,
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
      throw Object.assign(new Error('尚未连接实验机。请在诊断中连接 SSH。'), {
        statusCode: 503,
        code: 'lab_unconfigured',
      });
    }
    return this.activeSession;
  }

  hasSession() {
    return Boolean(this.activeSession);
  }

  async clearSession() {
    const session = this.activeSession;
    this.activeKernel = null;
    this.activeSession = null;
    this.activeFingerprint = null;
    if (session && typeof session.dispose === 'function') {
      await session.dispose();
    }
  }

  getActiveKernel() {
    return this.activeKernel ? { ...this.activeKernel } : null;
  }

  describePlan(kernel) {
    if (!kernel) return null;
    return this.getProviderForKernel(kernel).planKernelSession(kernel);
  }

  describeSession() {
    try {
      const session = this.getSession();
      return {
        session_ready: true,
        port_map: session.getPortMap(),
      };
    } catch {
      return { session_ready: false, port_map: {} };
    }
  }

  async probeKernel(kernel) {
    if (!kernel) return null;
    return this.getProviderForKernel(kernel).probe(kernel);
  }

  async ensureDefaultSession({ preferKernelId = null } = {}) {
    const kernels = this.kernelRegistry.listKernels().filter(kernel => kernel.implemented !== false);
    if (!kernels.length) {
      throw new Error('No kernels registered');
    }
    const preferred = preferKernelId
      ? kernels.find(kernel => kernel.id === preferKernelId)
      : null;
    return this.ensureForKernel(preferred || kernels[0]);
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
    const preferredKernelId = this.kernelSelectionStore
      ? await this.kernelSelectionStore.getPreferredKernel(packageDigest)
      : null;
    const resolution = this.kernelRegistry.resolveForPackage(pkg, { preferredKernelId });
    if (!resolution.selected) {
      throw Object.assign(new Error('No compatible kernel found for this package'), {
        statusCode: 409,
        code: 'kernel_missing',
      });
    }
    return this.ensureForKernel(resolution.selected);
  }

  async selectKernelForTutorial(tutorialKey, kernelId) {
    if (!this.packageService) {
      throw new Error('RuntimeManager requires packageService to resolve tutorials');
    }
    const { cfg, packageDigest } = await this.packageService.loadTutorialConfig(tutorialKey);
    const pkg = {
      ...cfg,
      version: cfg.version || '0.0.0',
      package_digest: packageDigest,
    };
    const resolution = this.kernelRegistry.resolveForPackage(pkg, { preferredKernelId: kernelId });
    if (!resolution.selected || resolution.selected.id !== kernelId) {
      throw Object.assign(
        new Error(`kernel is not compatible with this package: ${kernelId}`),
        { statusCode: 409, code: 'kernel_incompatible' }
      );
    }
    if (this.kernelSelectionStore) {
      await this.kernelSelectionStore.setPreferredKernel(packageDigest, kernelId);
    }
    const ensured = await this.ensureForKernel(resolution.selected);
    return {
      ...ensured,
      package_digest: packageDigest,
      resolution,
    };
  }

  async ensureForKernel(kernel) {
    const provider = this.getProviderForKernel(kernel);
    const plan = provider.planKernelSession(kernel);
    const workspaceStrategy = plan.workspaceStrategy
      || provider.workspaceStrategy(kernel)
      || describeRuntimeInternalStrategy({ location: kernel.workspace });

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
        workspaceStrategy: this.activeSession.workspaceStrategy || workspaceStrategy,
      };
    }

    await provider.applyKernel(kernel);
    const session = await provider.startSession();
    session.workspaceStrategy = workspaceStrategy;
    const replaced = Boolean(
      this.activeKernel && (
        this.activeKernel.id !== kernel.id || this.activeFingerprint !== plan.fingerprint
      )
    );
    if (replaced && this.activeSession && this.activeSession !== session) {
      await this.activeSession.dispose();
    }

    this.activeKernel = { ...kernel };
    this.activeSession = session;
    this.activeFingerprint = plan.fingerprint;

    return {
      session,
      kernel: this.activeKernel,
      provider,
      replaced,
      plan,
      workspaceStrategy,
    };
  }
}
