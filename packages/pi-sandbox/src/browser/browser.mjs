/** Chromium provider using the configured container proxy. */
import { spawn } from 'node:child_process';
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { browserRoot, viewerLink, chromiumCommand } from './viewer.mjs';
import { BetterWright } from 'betterwright';

export class SandboxBrowser {
  vault = false;
  downloadPolicy = 'ask';
  #id = randomBytes(16).toString('hex');
  #pending;
  #client;
  #process;
  #profile;
  #onExit = () => this.#process?.kill('SIGKILL');

  async #start() {
    const root = browserRoot;
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.#profile = join(root, this.#id);
    await mkdir(this.#profile, { mode: 0o700 });
    try {
      const runtime = join(this.#profile, 'browser/runtime');
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await copyFile('/opt/betterwright/adblock-cache/ad-blocker-2.18.2.bin',
        join(runtime, 'ad-blocker-2.18.2.bin'));
      const [binary, ...args] = chromiumCommand(this.#id);
      this.#process = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      process.once('exit', this.#onExit);
      const endpoint = await new Promise((resolve, reject) => {
        const lines = createInterface({ input: this.#process.stderr });
        const timer = setTimeout(() => finish(new Error('Browser startup timed out')), 60000);
        let diagnostic = '';
        const onError = error => finish(error);
        const onExit = code => finish(new Error(`Browser exited (${code}): ${diagnostic.slice(-2000)}`));
        const finish = (error, value) => {
          clearTimeout(timer); lines.removeAllListeners(); lines.close();
          this.#process.off('error', onError); this.#process.off('exit', onExit);
          if (error) reject(error); else resolve(value);
        };
        this.#process.once('error', onError); this.#process.once('exit', onExit);
        lines.on('line', line => {
          diagnostic += line + '\n';
          const match = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)$/.exec(line);
          if (match) finish(null, match[1]);
        });
      });
      // Continue draining Chromium diagnostics after its readiness message.
      this.#process.stderr.resume();
      this.#client = new BetterWright({ provider: { cdpUrl: endpoint },
        home: this.#profile, headless: true, vault: false, downloadPolicy: this.downloadPolicy });
      return this.#client;
    } catch (error) {
      await this.#cleanup();
      throw error;
    }
  }

  async run(code, options) {
    this.#pending ??= this.#start().catch(error => { this.#pending = undefined; throw error; });
    return (await this.#pending).run(code, options);
  }

  async viewerLink() {
    this.#pending ??= this.#start().catch(error => { this.#pending = undefined; throw error; });
    await this.#pending;
    return viewerLink(this.#id);
  }

  async #cleanup() {
    process.off('exit', this.#onExit);
    const child = this.#process;
    this.#process = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    if (this.#profile) await rm(this.#profile, { recursive: true, force: true });
    this.#profile = undefined;
  }

  async close() {
    try { await this.#pending; await this.#client?.close(); }
    finally { await this.#cleanup(); this.#client = undefined; this.#pending = undefined; }
  }
}
