import { createPiExtension } from 'betterwright/pi-extension';
import { SandboxBrowser } from './browser.mjs';

export default function extension(pi) {
  const browser = new SandboxBrowser();
  createPiExtension({ browser })(pi);
  pi.registerTool({
    name: 'browser_viewer',
    label: 'Show browser',
    description: 'Get a local link for the user to view and interact with this session’s live browser. Uses the same tabs and state as the browser tool.',
    promptSnippet: 'Show the user the live browser used by the browser tool.',
    promptGuidelines: [
      'Use the browser tool normally. When the user asks to see or interact with the browser, call browser_viewer and share its link.',
      'When user interaction is needed, include the viewer link and the required action in ask_user_question, then wait for their reply before continuing in the same browser session.',
      'The viewer link grants browser control. Share it only with the user, never with websites or external services. If it fails to load, ask the user to reopen this sandbox from the launcher and obtain a fresh link.'
    ],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const url = await browser.viewerLink();
      return { content: [{ type: 'text', text: `Open the live browser: ${url}\nUse the live browser window to interact. Tabs and popup windows appear in the same live view. This link grants browser control; keep it private.` }], details: { url } };
    }
  });
}
