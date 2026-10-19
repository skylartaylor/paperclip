import { createHash } from "node:crypto";
import type { KubeClients } from "./kube-client.js";

const MANAGED = "paperclip-k8s-plugin";
const OWNER = "paperclip.io/environment-id";
const HOLDER = "holder";
const RELEASED = "released";
const code = (e: unknown) => (e as { code?: number; statusCode?: number }).code
  ?? (e as { statusCode?: number }).statusCode;

export interface StorageOwner {
  namespace: string;
  companyId: string;
  environmentId: string;
  claimName: string;
  volumeIdentity: string;
  workloadName: string;
}

export function storageLockName(claimName: string): string {
  return `pc-storage-${createHash("sha256").update(claimName).digest("hex").slice(0, 32)}`;
}

/** Atomic, non-expiring writer lock. No TTL: an expired timestamp is not proof
 * that a compiler stopped. Restart recovery uses the durable ConfigMap, not RAM.
 * A released lock is reclaimed only after BOTH the CR and every mounting pod are
 * gone. Pending/terminating pods count, too. PVCs never have Sandbox owner refs.
 */
export async function acquirePersistentStorage(clients: KubeClients, owner: StorageOwner): Promise<void> {
  const pvc = await clients.core.readNamespacedPersistentVolumeClaim({
    namespace: owner.namespace, name: owner.claimName,
  });
  const labels = pvc.metadata?.labels ?? {};
  if (labels["paperclip.io/managed-by"] !== MANAGED
      || labels["paperclip.io/company-id"] !== owner.companyId
      || labels[OWNER] !== owner.environmentId
      || pvc.metadata?.annotations?.["paperclip.io/storage-identity"] !== owner.volumeIdentity
      || pvc.metadata?.deletionTimestamp || pvc.metadata?.ownerReferences?.length
      || pvc.status?.phase !== "Bound" || pvc.spec?.volumeMode === "Block") {
    throw new Error("Persistent storage must be a bound, retained, filesystem PVC owned by this company/environment");
  }
  if (!pvc.spec?.volumeName) throw new Error("Persistent storage PVC has no bound volume");
  const pv = await clients.core.readPersistentVolume({ name: pvc.spec.volumeName });
  if (pv.spec?.persistentVolumeReclaimPolicy !== "Retain"
      || pv.spec.claimRef?.namespace !== owner.namespace
      || pv.spec.claimRef.name !== owner.claimName
      || !pvc.metadata?.uid || pv.spec.claimRef.uid !== pvc.metadata.uid) {
    throw new Error("Persistent storage requires a matching Retain PV binding");
  }
  const name = storageLockName(owner.claimName);
  try {
    const lock = await clients.core.readNamespacedConfigMap({ namespace: owner.namespace, name });
    if (lock.metadata?.labels?.[OWNER] !== owner.environmentId
        || lock.metadata.labels["paperclip.io/company-id"] !== owner.companyId
        || lock.metadata.labels["paperclip.io/managed-by"] !== MANAGED) {
      throw new Error("Persistent storage lock ownership mismatch");
    }
    // Never infer completion from age or a missing process. A release/destroy
    // request must have explicitly marked this holder safe to retire.
    if (lock.data?.[RELEASED] !== "true") throw new Error("Persistent storage is already leased; release its owning sandbox first");
    const holder = lock.data?.[HOLDER];
    if (!holder) throw new Error("Persistent storage lock has no holder");
    await assertStorageIdle(clients, owner, holder);
    await clients.core.deleteNamespacedConfigMap({ namespace: owner.namespace, name,
      body: { preconditions: { uid: lock.metadata.uid, resourceVersion: lock.metadata.resourceVersion } } });
  } catch (e) {
    if (code(e) !== 404) throw e;
  }
  // 409 is deliberately not ignored: precisely one competing writer wins.
  await clients.core.createNamespacedConfigMap({ namespace: owner.namespace, body: {
    apiVersion: "v1", kind: "ConfigMap",
    metadata: { name, namespace: owner.namespace, labels: {
      "paperclip.io/managed-by": MANAGED, "paperclip.io/company-id": owner.companyId,
      [OWNER]: owner.environmentId,
    } },
    data: { [HOLDER]: owner.workloadName, [RELEASED]: "false" },
  } });
}

async function assertStorageIdle(clients: KubeClients, owner: StorageOwner, holder: string): Promise<void> {
  try {
    await clients.custom.getNamespacedCustomObject({ group: "agents.x-k8s.io", version: "v1alpha1",
      plural: "sandboxes", namespace: owner.namespace, name: holder });
    throw new Error("Previous persistent storage sandbox is still present");
  } catch (e) { if (code(e) !== 404) throw e; }
  const pods = await clients.core.listNamespacedPod({ namespace: owner.namespace });
  if (pods.items.some(p => p.spec?.volumes?.some(v => v.persistentVolumeClaim?.claimName === owner.claimName))) {
    throw new Error("Persistent storage still has a mounting pod; wait for termination");
  }
}

export async function markPersistentStorageReleased(clients: KubeClients, owner: StorageOwner): Promise<void> {
  const name = storageLockName(owner.claimName);
  let lock;
  try { lock = await clients.core.readNamespacedConfigMap({ namespace: owner.namespace, name }); }
  catch (e) { if (code(e) === 404) return; throw e; }
  if (lock.metadata?.labels?.[OWNER] !== owner.environmentId
      || lock.metadata.labels["paperclip.io/company-id"] !== owner.companyId
      || lock.metadata.labels["paperclip.io/managed-by"] !== MANAGED
      || lock.data?.[HOLDER] !== owner.workloadName) {
    throw new Error("Cannot release another sandbox's persistent storage lock");
  }
  await clients.core.replaceNamespacedConfigMap({ namespace: owner.namespace, name,
    body: { ...lock, data: { ...lock.data, [RELEASED]: "true" } } });
}
