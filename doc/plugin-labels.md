# Native labels for self-hosted plugins

The worker SDK exposes `ctx.issues.listLabels(companyId)` under `issues.read`
and `ctx.issues.ensureLabel({companyId, name, color})` under `issues.update`.
Both calls enforce the current invocation company before entering the host
service. They never accept an existing label ID from another company.

`ensureLabel` reuses the normal label validator and unique company/name index.
Concurrent calls for the same exact name return the same label. Existing names
and colors are preserved. Newly created labels record a plugin-attributed
`label.created` activity event. Native `labelIds` can then be attached through
the existing scoped issue create/update API; no board token or direct API
fallback is required. The extension does not grant rename or deletion methods.

Deploy the matching worker SDK together with the host extension. Plugins may
feature-detect these methods to retain compatibility with an older host/SDK.
