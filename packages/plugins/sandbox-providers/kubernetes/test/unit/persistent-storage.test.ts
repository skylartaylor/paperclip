import { describe, it, expect, vi } from "vitest";
import type { KubeClients } from "../../src/kube-client.js";
import { acquirePersistentStorage, markPersistentStorageReleased } from "../../src/persistent-storage.js";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";
import { kubernetesProviderConfigSchema } from "../../src/types.js";

const owner = { namespace: "paperclip-test", companyId: "company", environmentId: "env", claimName: "rust-work", workloadName: "pc-first" };
function fixture() {
  let lock: any = null;
  const pvc: any = { metadata: { uid: "pvc-uid", labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin", "paperclip.io/company-id": "company", "paperclip.io/environment-id": "env" } }, spec: { volumeName: "pv" }, status: { phase: "Bound" } };
  const pv: any = { spec: { persistentVolumeReclaimPolicy: "Retain", claimRef: { namespace: owner.namespace, name: owner.claimName, uid: "pvc-uid" } } };
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(async () => pvc), readPersistentVolume: vi.fn(async () => pv),
    readNamespacedConfigMap: vi.fn(async () => { if (!lock) throw { code: 404 }; return structuredClone(lock); }),
    createNamespacedConfigMap: vi.fn(async ({ body }: any) => { if (lock) throw { code: 409 }; lock = { ...body, metadata: { ...body.metadata, uid: "lock-uid", resourceVersion: "1" } }; return lock; }),
    replaceNamespacedConfigMap: vi.fn(async ({ body }: any) => { lock = body; return body; }),
    deleteNamespacedConfigMap: vi.fn(async ({ body }: any) => { expect(body.preconditions).toEqual({ uid: "lock-uid", resourceVersion: "1" }); lock = null; }),
    listNamespacedPod: vi.fn(async () => ({ items: [] as any[] })),
  };
  const custom = { getNamespacedCustomObject: vi.fn(async () => { throw { code: 404 }; }) };
  return { core, custom, pvc, pv, clients: { core, custom } as unknown as KubeClients };
}

describe("persistent Rust storage ownership and writer fencing", () => {
  it("admits exactly one concurrent acquisition", async () => {
    const f = fixture();
    const results = await Promise.allSettled([acquirePersistentStorage(f.clients, owner), acquirePersistentStorage(f.clients, { ...owner, workloadName: "pc-second" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("does not infer release from a missing workload, even after worker restart", async () => {
    const f = fixture(); await acquirePersistentStorage(f.clients, owner);
    await expect(acquirePersistentStorage(f.clients, { ...owner, workloadName: "pc-second" })).rejects.toThrow(/already leased/);
    expect(f.custom.getNamespacedCustomObject).not.toHaveBeenCalled();
  });
  it("recovers an explicitly released lease only after the workload and pods disappear", async () => {
    const f = fixture(); await acquirePersistentStorage(f.clients, owner); await markPersistentStorageReleased(f.clients, owner);
    f.custom.getNamespacedCustomObject.mockResolvedValueOnce({} as never);
    await expect(acquirePersistentStorage(f.clients, { ...owner, workloadName: "pc-second" })).rejects.toThrow(/still present/);
    f.core.listNamespacedPod.mockResolvedValueOnce({ items: [{ metadata: { deletionTimestamp: "now" }, spec: { volumes: [{ persistentVolumeClaim: { claimName: owner.claimName } }] } }] });
    await expect(acquirePersistentStorage(f.clients, { ...owner, workloadName: "pc-second" })).rejects.toThrow(/mounting pod/);
    await acquirePersistentStorage(f.clients, { ...owner, workloadName: "pc-second" });
    await expect(markPersistentStorageReleased(f.clients, owner)).rejects.toThrow(/another sandbox/);
  });
  it.each(["paperclip.io/company-id", "paperclip.io/environment-id", "paperclip.io/managed-by"])("rejects foreign PVC %s", async key => {
    const f = fixture(); f.pvc.metadata.labels[key] = "other";
    await expect(acquirePersistentStorage(f.clients, owner)).rejects.toThrow(/owned/);
    expect(f.core.createNamespacedConfigMap).not.toHaveBeenCalled();
  });
  it("rejects a disposable PVC or deleting volume", async () => {
    const f = fixture(); f.pvc.metadata.ownerReferences = [{ uid: "sandbox" }];
    await expect(acquirePersistentStorage(f.clients, owner)).rejects.toThrow(/retained/);
  });
  it("rejects Delete reclaim policy and mismatched binding UIDs", async () => {
    const f = fixture(); f.pv.spec.persistentVolumeReclaimPolicy = "Delete";
    await expect(acquirePersistentStorage(f.clients, owner)).rejects.toThrow(/Retain/);
    f.pv.spec.persistentVolumeReclaimPolicy = "Retain"; f.pv.spec.claimRef.uid = "replacement";
    await expect(acquirePersistentStorage(f.clients, owner)).rejects.toThrow(/binding/);
  });
  it("fails closed on an unavailable API", async () => {
    const f = fixture(); f.core.readNamespacedConfigMap.mockRejectedValueOnce({ code: 403 });
    await expect(acquirePersistentStorage(f.clients, owner)).rejects.toEqual({ code: 403 });
    expect(f.core.createNamespacedConfigMap).not.toHaveBeenCalled();
  });
});

describe("persistent storage runtime contract", () => {
  it("mounts source and toolchain-keyed Cargo storage while keeping auth home ephemeral", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const manifest: any = buildSandboxCrManifest({ namespace: owner.namespace, sandboxName: owner.workloadName,
      adapterType: "codex_local", image: "image@sha256:abc", envSecretName: "env", serviceAccountName: "sa", labels: {}, resources: {},
      persistentStorage: { claimName: owner.claimName, cacheKey: "rust-1_92" }, expiresAt });
    const pod = manifest.spec.podTemplate.spec;
    expect(pod.volumes).toContainEqual({ name: "persistent", persistentVolumeClaim: { claimName: owner.claimName } });
    expect(pod.volumes).toContainEqual({ name: "home", emptyDir: { sizeLimit: "1Gi" } });
    expect(pod.containers[0].volumeMounts).toContainEqual({ name: "persistent", mountPath: "/cargo", subPath: "cargo/rust-1_92" });
    expect(pod.containers[0].env).toContainEqual({ name: "CARGO_TARGET_DIR", value: "/cargo/target" });
    expect(pod.initContainers[0].securityContext.runAsNonRoot).toBe(true);
    expect(manifest.spec.shutdownTime).toBe(expiresAt); expect(manifest.spec.shutdownPolicy).toBe("Delete");
    expect(pod.activeDeadlineSeconds).toBeLessThanOrEqual(60);
    expect(pod.containers[0].command.join(" ")).toContain("date +%s");
    expect(JSON.stringify(manifest)).not.toContain("hostPath");
  });
  it.each(["../escape", "a/b", "$(touch bad)", ""])("rejects unsafe cache key %s", cacheKey => {
    expect(kubernetesProviderConfigSchema.safeParse({ inCluster: true, persistentStorage: { claimName: "work", cacheKey } }).success).toBe(false);
  });
  it("rejects persistent storage on one-shot jobs", () => {
    expect(kubernetesProviderConfigSchema.safeParse({ inCluster: true, backend: "job", persistentStorage: { claimName: "work", cacheKey: "rust" } }).success).toBe(false);
  });
});
