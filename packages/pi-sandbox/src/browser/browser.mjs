/** Chromium provider using the configured container proxy. */
import { spawn } from 'node:child_process';
import { mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { browserRoot, viewerLink } from './viewer.mjs';
import { startDesktop } from './desktop.mjs';
import { BetterWright, createLocalCredentialVault } from 'betterwright';

export class SandboxBrowser {
  vault = createLocalCredentialVault({ dir: join(homedir(), '.betterwright', 'vault') });
  downloadPolicy = 'ask';
  #id = randomBytes(16).toString('hex');
  #pending;
  #client;
  #process;
  #profile;
  #desktop;
  #recovering;
  #recoveryError;
  #closing=false;
  #epoch=0;
  #closePending;
  #onExit = () => { this.#process?.kill('SIGKILL'); this.#desktop?.kill(); };

  async #start() {
    await this.#cleanup(false);
    const root = browserRoot;
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.#profile = join(root, this.#id);
    await mkdir(this.#profile, { mode: 0o700 });
    try {
      const runtime = join(this.#profile, 'browser/runtime');
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await copyFile('/opt/betterwright/adblock-cache/ad-blocker-2.18.2.bin',
        join(runtime, 'ad-blocker-2.18.2.bin'));
      await mkdir(join(this.#profile, 'Default'), {mode:0o700});
      await writeFile(join(this.#profile, 'Default/Preferences'), JSON.stringify({
        credentials_enable_service:false, profile:{password_manager_enabled:false},
      }), {mode:0o600});
      this.#desktop = await startDesktop(this.#profile);
      const args = ['--ozone-platform=x11', '--start-maximized', '--test-type', '--no-sandbox', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--user-data-dir=' + this.#profile];
      if (process.env.SANDBOX_NETWORK_MODE !== 'unrestricted') {
        args.push('--proxy-server=http://127.0.0.1:3128', '--proxy-bypass-list=<-loopback>');
      }
      this.#process = spawn('setpriv',
        ['--pdeathsig', 'KILL', '--', '/opt/betterwright/chromium', ...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: this.#desktop.env });
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
        home: this.#profile, headless: false, credentialCapture: false, vault: this.vault, downloadPolicy: this.downloadPolicy });
      // Attach policy and download handlers before the viewer can navigate.
      const ready = await this.#client.run('return true');
      if (!ready.ok) throw Error('Browser initialization failed: ' + ready.error);
      const child=this.#process;
      const recover=()=>{
        if(this.#closing || this.#process!==child || this.#recovering)return;
        this.#recovering=(async()=>{
          try {await this.#client?.close();} catch {}
          try {await this.#cleanup(false);} catch(error){this.#recoveryError=error;}
          finally {this.#client=undefined;this.#pending=undefined;}
        })().finally(()=>{this.#recovering=undefined;});
      };
      child.once('exit',recover);
      this.#desktop.onFailure(recover);
      if(child.exitCode!==null || child.signalCode!==null)recover();
      return this.#client;
    } catch (error) {
      await this.#cleanup(false);
      throw error;
    }
  }

  async #ensure(attempt=0,epoch=this.#epoch) {
    const active=()=>{if(this.#closing || epoch!==this.#epoch)throw Error('Browser is closing');};
    active();
    await this.#recovering;
    active();
    if(this.#recoveryError){const error=this.#recoveryError;this.#recoveryError=undefined;throw error;}
    this.#pending ??= this.#start().catch(error => { this.#pending = undefined; throw error; });
    const client=await this.#pending;
    active();
    if(this.#recovering){
      await this.#recovering;
      if(attempt>=1)throw Error('Browser could not remain running after restart. Retry the browser tool or start a fresh session.');
      return this.#ensure(attempt+1,epoch);
    }
    return client;
  }

  async run(code, options) {
    return (await this.#ensure()).run(code, options);
  }

  async fillCredential(options) {
    return (await this.#ensure()).fillCredential(options);
  }

  async viewerLink() {
    await this.#ensure();
    return viewerLink(this.#id);
  }

  async #cleanup(dispose=true) {
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
    await this.#desktop?.close();
    this.#desktop = undefined;
    if(dispose)this.vault.dispose();
    if (this.#profile) await rm(this.#profile, { recursive: true, force: true });
    this.#profile = undefined;
  }

  close() {
    if(this.#closePending)return this.#closePending;
    this.#closing=true;this.#epoch++;
    this.#closePending=(async()=>{
      try {await this.#recovering;await this.#pending;await this.#client?.close();}
      finally {
        try {await this.#cleanup();}
        finally {this.#client=undefined;this.#pending=undefined;}
      }
    })().finally(()=>{this.#closing=false;this.#closePending=undefined;});
    return this.#closePending;
  }
}
