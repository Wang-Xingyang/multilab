export class RuntimeProvider {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind;
  }

  async startSession() {
    throw new Error('RuntimeProvider.startSession() must be implemented');
  }
}

export class RuntimeSession {
  async ensure() {
    throw new Error('RuntimeSession.ensure() must be implemented');
  }

  async writeFiles() {
    throw new Error('RuntimeSession.writeFiles() must be implemented');
  }

  async readFiles() {
    throw new Error('RuntimeSession.readFiles() must be implemented');
  }

  async uploadScript() {
    throw new Error('RuntimeSession.uploadScript() must be implemented');
  }

  async runCaptured() {
    throw new Error('RuntimeSession.runCaptured() must be implemented');
  }

  async attachTerminal() {
    throw new Error('RuntimeSession.attachTerminal() must be implemented');
  }

  async interrupt() {
    throw new Error('RuntimeSession.interrupt() must be implemented');
  }

  async resize() {
    throw new Error('RuntimeSession.resize() must be implemented');
  }
}

