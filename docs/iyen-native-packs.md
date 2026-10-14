# IYEN native skill packs

The IYEN Worker advertises search_packs and load_pack alongside the existing three skill read tools. OAuth remains restricted to skills:read and the IYEN GitHub user allowlist. Separate writer credentials can create/update packs and poll publication status. Legacy skill RPCs remain compatible with releases without packs.

Pack loads resolve version-pinned definitions and member metadata. Combined loads deduplicate canonical member URIs while preserving scenario requirements; selected bodies must still be read separately. A verified staged snapshot is distinct from an active published release. Codex and OpenClaw loaders preserve explicit invocation and existing authorization.

Deploy the Worker before publishing pack content. Keep IYEN OAuth/KV/R2 settings, enable GISUL_NATIVE_TOOLS for bearer publication checks, and set GISUL_SERVER_VERSION to the deployed source commit. The content repository independently checks pack bytes, references, registration accounts, staged resolution and active publication. Existing skill attribution is not migrated by this pack change.

Validation includes Worker schema, write race/conflict and active/staged tests; OAuth read-only enforcement; server/client regression tests; and the content publisher's real workerd staging/promotion integration.
