import { getPermissionsService } from "@gotgenes/pi-permission-system";

/** Share the live root permission queue with native file dialogs in both clients. */
export function runManagedApprovalDialog(sessionId: string, present: () => Promise<boolean>): Promise<boolean> {
  const service = getPermissionsService(sessionId);
  const admit = service && Object.getOwnPropertyDescriptor(service, Symbol.for("pi-auto-review:admit-managed-dialog"))?.value;
  return typeof admit === "function" ? admit(present) : Promise.resolve(false);
}
