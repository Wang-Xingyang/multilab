import path from 'path';
import fs from 'fs/promises';

export class KernelSelectionStore {
  constructor({ runtimeStateDir }) {
    this.storePath = path.join(runtimeStateDir, 'kernel-selection.json');
  }

  async getPreferredKernel(packageDigest) {
    const digest = validatePackageDigest(packageDigest);
    const store = await this.readStore();
    const kernelId = store.packages[digest]?.kernel_id || null;
    return kernelId ? validateKernelId(kernelId) : null;
  }

  async setPreferredKernel(packageDigest, kernelId) {
    const digest = validatePackageDigest(packageDigest);
    const selected = validateKernelId(kernelId);
    const store = await this.readStore();
    store.packages[digest] = {
      kernel_id: selected,
      updated_at: new Date().toISOString(),
    };
    await this.writeStore(store);
    return {
      package_digest: digest,
      kernel_id: selected,
      updated_at: store.packages[digest].updated_at,
    };
  }

  async readStore() {
    try {
      const store = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
      return {
        packages: store.packages && typeof store.packages === 'object' ? store.packages : {},
      };
    } catch (e) {
      if (e.code === 'ENOENT') return { packages: {} };
      throw e;
    }
  }

  async writeStore(store) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await fs.rename(tempPath, this.storePath);
  }
}

function validatePackageDigest(packageDigest) {
  const digest = String(packageDigest || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return digest;
}

function validateKernelId(kernelId) {
  const id = String(kernelId || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id)) {
    throw Object.assign(new Error('Invalid kernel id'), { statusCode: 400 });
  }
  return id;
}
