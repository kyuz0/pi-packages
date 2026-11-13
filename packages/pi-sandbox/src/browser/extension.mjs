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
  pi.registerTool({
    name:'browser_session_export',
    label:'Save service login for scripts',
    description:'After an authorized user login in this session’s browser, save only cookies matching a specific service URL into a private local 0600 Cookie-header file outside the workspace. Returns its path and count, never cookie values. Requires permission review. Scripts can read the file through an authorized bash_escalate command; ordinary sandboxed Bash masks the private home. Does not export passwords, browser profiles or unrelated sites.',
    promptSnippet:'Hand an authorized service login privately from the live browser to a local script.',
    promptGuidelines:[
      'Use browser and browser_viewer to let the user sign in; wait for their reply. Then use browser_session_export only for the service they authorized and the exact API URL their script will call.',
      'Never print the resulting session file, send its contents to an advisor, or put it in Git. Use it only for requests to that same service. Re-export after the session expires.',
    ],
    parameters:{type:'object',properties:{url:{type:'string',description:'Exact HTTPS API URL whose matching session cookies are needed; loopback HTTP is allowed for local applications. No query, fragment or URL credentials.'}},required:['url'],additionalProperties:false},
    async execute(_id,params,signal) {
      try {
        const saved = await browser.exportSession(params.url,{signal});
        return {content:[{type:'text',text:`Service session saved privately for ${saved.url}. Cookie file: ${saved.path}. Matching cookies: ${saved.cookieCount}. Read it only in the authorized same-service client; do not print its contents.`}],details:saved};
      } catch(error) {
        return {isError:true,content:[{type:'text',text:error.message}]};
      }
    }
  });
}
