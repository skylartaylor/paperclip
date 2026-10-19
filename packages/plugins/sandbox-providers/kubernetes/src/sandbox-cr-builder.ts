/**
 * Builds a kubernetes-sigs/agent-sandbox Sandbox CR manifest.
 *
 * The Sandbox CR creates a long-lived pod (sleep infinity entrypoint) into
 * which paperclip-server can exec arbitrary commands. This solves the
 * architectural mismatch with the batch/v1 Job backend, which only supports
 * a single one-shot entrypoint — not the multi-command adapter-install pattern
 * used by paperclip-server.
 *
 * Security baseline is identical to buildJobManifest (pod-spec-builder.ts):
 * non-root, drop ALL caps, read-only rootFS, Tini PID 1, seccomp
 * RuntimeDefault, fsGroupChangePolicy OnRootMismatch, automountSAToken=false.
 *
 * NOTE: paperclip-server runs OUTSIDE the cluster, so we cannot set ownerReferences
 * on the Sandbox CR (the owner would need to be an in-cluster resource). The
 * release path is explicit delete via sandboxCrOrchestrator.release().
 */

export interface BuildSandboxCrManifestInput {
  namespace: string;
  sandboxName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  expiresAt?: string;
  persistentStorage?: { claimName: string; cacheKey: string; volumeIdentity: string };
  runtimeClassName?: string;
  imagePullSecrets?: string[];
}

export function buildSandboxCrManifest(
  input: BuildSandboxCrManifestInput,
): Record<string, unknown> {
  const podLabels: Record<string, string> = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: input.sandboxName,
      namespace: input.namespace,
      labels: { ...input.labels },
      // No ownerReferences: paperclip-server is out-of-cluster. Release is
      // explicit delete.
    },
    spec: {
      ...(input.expiresAt ? { shutdownTime: input.expiresAt, shutdownPolicy: "Delete" } : {}),
      podTemplate: {
        metadata: {
          labels: podLabels,
        },
        spec: {
          ...(input.expiresAt ? {
            activeDeadlineSeconds: Math.max(1, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1000)),
          } : {}),
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          // Sandbox controller requires restartPolicy: Always so the pod
          // stays running between exec calls.
          restartPolicy: "Always",
          ...(input.runtimeClassName
            ? { runtimeClassName: input.runtimeClassName }
            : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? {
                imagePullSecrets: input.imagePullSecrets.map((name) => ({
                  name,
                })),
              }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          ...(input.persistentStorage ? {
            initContainers: [{
              name: "prepare-storage", image: input.image,
              command: ["/bin/sh", "-ec", `test "$(cat /persist/.paperclip-storage-id)" = "${input.persistentStorage.volumeIdentity}"; mkdir -p /persist/workspace/.paperclip-runtime /persist/cargo/${input.persistentStorage.cacheKey}/registry /persist/cargo/${input.persistentStorage.cacheKey}/git /persist/cargo/${input.persistentStorage.cacheKey}/target /home/paperclip/.cargo`],
              volumeMounts: [{ name: "persistent", mountPath: "/persist" }, { name: "home", mountPath: "/home/paperclip" }],
              securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
                readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: { requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "32Mi" }, limits: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "64Mi" } },
            }],
          } : {}),
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              // sleep infinity keeps the pod running; paperclip-server execs
              // commands into it via Kubernetes exec API. Tini as PID 1 for
              // proper signal forwarding and zombie reaping.
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                input.expiresAt
                  ? `remaining=$((${Math.floor(Date.parse(input.expiresAt) / 1000)} - $(date +%s))); [ "$remaining" -gt 0 ] && exec sleep "$remaining"; exit 0`
                  : "sleep infinity",
              ],
              // HOME must point at a writable mount; the image's default
               // HOME=/home/node is inside the readOnly root filesystem.
               // Claude (and most agent runtimes) silently exit with code 0
               // and no output when HOME is unwritable, so set this explicitly.
              env: [{ name: "HOME", value: "/home/paperclip" },
                ...(input.persistentStorage ? [
                  { name: "CARGO_HOME", value: "/home/paperclip/.cargo" },
                  { name: "CARGO_TARGET_DIR", value: "/cargo/target" },
                ] : []),
              ],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: {
                  cpu: "250m",
                  memory: "512Mi",
                  "ephemeral-storage": "2Gi",
                  ...input.resources.requests,
                },
                limits: {
                  cpu: "2",
                  memory: "4Gi",
                  "ephemeral-storage": "4Gi",
                  ...input.resources.limits,
                },
              },
              volumeMounts: [
                ...(input.persistentStorage ? [
                  { name: "persistent", mountPath: "/workspace", subPath: "workspace" },
                  // Managed runtime homes contain account credentials. Keep the
                  // entire native staging root off the retained workspace PVC.
                  { name: "managed-runtime", mountPath: "/workspace/.paperclip-runtime" },
                  { name: "persistent", mountPath: "/cargo/target", subPath: `cargo/${input.persistentStorage.cacheKey}/target` },
                  { name: "persistent", mountPath: "/home/paperclip/.cargo/registry", subPath: `cargo/${input.persistentStorage.cacheKey}/registry` },
                  { name: "persistent", mountPath: "/home/paperclip/.cargo/git", subPath: `cargo/${input.persistentStorage.cacheKey}/git` },
                ] : [{ name: "workspace", mountPath: "/workspace" }]),
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            ...(input.persistentStorage
              ? [{ name: "persistent", persistentVolumeClaim: { claimName: input.persistentStorage.claimName } },
                 { name: "managed-runtime", emptyDir: { sizeLimit: "2Gi" } }]
              : [{ name: "workspace", emptyDir: { sizeLimit: "8Gi" } }]),
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
          ],
        },
      },
    },
  };
}
