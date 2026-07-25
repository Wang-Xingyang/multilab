import path from 'path';
import fs from 'fs/promises';

const USER_SETTABLE_TRUST = new Set(['untrusted', 'user-trusted']);

export class TrustStore {
  constructor({ runtimeStateDir }) {
    this.trustPath = path.join(runtimeStateDir, 'trust.json');
  }

  async getPackageTrust(packageDigest) {
    const digest = validatePackageDigest(packageDigest);
    const store = await this.readStore();
    const record = store.packages[digest];
    if (!record) {
      return {
        package_digest: digest,
        trust: 'untrusted',
        default: true,
      };
    }
    return {
      package_digest: digest,
      trust: record.trust,
      updated_at: record.updated_at,
      default: false,
    };
  }

  async setPackageTrust(packageDigest, trust) {
    const digest = validatePackageDigest(packageDigest);
    if (!USER_SETTABLE_TRUST.has(trust)) {
      throw Object.assign(
        new Error(`trust must be one of ${Array.from(USER_SETTABLE_TRUST).sort().join(', ')}`),
        { statusCode: 400 }
      );
    }

    const store = await this.readStore();
    store.packages[digest] = {
      trust,
      updated_at: new Date().toISOString(),
    };
    await this.writeStore(store);
    return this.getPackageTrust(digest);
  }

  async annotatePackage(packageInfo) {
    const trust = await this.getPackageTrust(packageInfo.package_digest);
    return {
      ...packageInfo,
      trust: trust.trust,
      trust_default: trust.default,
    };
  }

  async readStore() {
    try {
      const store = JSON.parse(await fs.readFile(this.trustPath, 'utf8'));
      return {
        packages: store.packages && typeof store.packages === 'object' ? store.packages : {},
      };
    } catch (e) {
      if (e.code === 'ENOENT') return { packages: {} };
      throw e;
    }
  }

  async writeStore(store) {
    await fs.mkdir(path.dirname(this.trustPath), { recursive: true });
    const tempPath = `${this.trustPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await fs.rename(tempPath, this.trustPath);
  }
}

function validatePackageDigest(packageDigest) {
  const digest = String(packageDigest || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return digest;
}

