import type { Message } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";

type State = { key: string; branch: string[]; messages: Message[]; admitted: string[]; busy: boolean };
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const providerFunctions = new WeakMap<object, number>();
let providerSequence = 0;
export function providerIdentity(fn: object | undefined): number {
  if (!fn) return 0;
  let id = providerFunctions.get(fn);
  if (id === undefined) { id = ++providerSequence; providerFunctions.set(fn, id); }
  return id;
}
const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((v, i) => v === b[i]);
/** Controller-owned, bounded to the most recent configuration for each live session manager. */
export class ConversationStore {
  private states = new WeakMap<object, State>();
  acquire(owner: object, key: string, entries: readonly unknown[], enabled: boolean) {
    const branch = entries.map(digest);
    const prior = this.states.get(owner);
    const valid = enabled && prior?.key === key && prefix(prior.branch, branch);
    const fork = Boolean(valid && prior.busy);
    const state: State = valid ? prior : { key, branch: [], messages: [], admitted: [], busy: false };
    const mode = !enabled ? "independent" : fork ? "fork" : valid ? "reused" : prior ? "reset" : "fresh";
    if (enabled && !fork) { state.busy = true; this.states.set(owner, state); }
    let settled = false;
    return {
      mode,
      invalidate: () => {
        if (!fork && this.states.get(owner) === state) this.states.delete(owner);
      },
      messages: structuredClone(state.messages),
      admitted: new Set(state.admitted),
      commit: (messages: Message[], admitted: Set<string>) => {
        if (settled || !enabled || fork || this.states.get(owner) !== state) return false;
        state.messages = structuredClone(messages); state.admitted = [...admitted]; state.branch = branch;
        state.busy = false; settled = true; return true;
      },
      release: () => { if (!settled && enabled && !fork && this.states.get(owner) === state) state.busy = false; settled = true; },
    } as const;
  }
}
export const reviewerConversations = new ConversationStore();
