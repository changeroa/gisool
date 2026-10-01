# Native skill packs

Packs are independent JSON resources in `Ark-Point/gisul-skills/packs/<name>.json`. They reference canonical skills without embedding instructions. The team HTTPS Worker exposes `search_packs`, `load_pack`, `create_pack`, `update_pack`, and `get_pack_write_status` to Codex; OAuth read/write scopes and organization checks are shared with skills. The legacy local Node registry does not serve packs.

## Definition and composition

Schema version 1 has `kind: "skill-pack"`, `name`, `display_name`, `description`, `scope`, and flat `members`. Every member has `uri`, `phase` (`scope`, `investigate`, `verify`, `handoff`, `explain`), `selection` (`required`, `when_applicable`, `when_requested`), and a textual `when`. There must be one required scope member, one required verifier, and at least one required investigation member. Unknown fields, noncanonical/foreign references, duplicates, missing skills, and nested packs are rejected.

`search_packs` takes subject/outcome terms and returns metadata, member roles/conditions, registration attribution, digest and commit. Use `mode: "explicit"` for a requested pack or bounded catalog listing. Discovery never activates instructions.

`load_pack({uris: ["pack://gisul/gisul/backend-pack", "pack://gisul/gisul/frontend-pack"], commit})` resolves definitions and members at one immutable catalog commit. It checks pack bytes, returns member SKILL.md and manifest digests and invocation policy, and reads no skill bodies. Shared canonical URIs occur once, with every source pack's conditions retained. Conflicting phases or different scope/verifier identities reject composition. The caller selects applicable members, records exclusions and actual evidence, and calls `load_skill` with that commit. Explicit-only skills retain their invocation restriction even when required by a pack; unavailable activation leaves coverage incomplete. Packs do not grant execution, delegation, publication or product-change permission.

## Integrity, writes and publication

The inventory's optional `packs` index preserves compatibility with old skill-only releases. Entries carry `uri`, exact `definition`, byte `digest`/`size`, and Git-derived registration. Pack JSON files are hashed in the same immutable release inventory. Publication validates reference closure, file/index identity, source bytes and attribution before switching the current pointer. Pinning a commit reproduces both definitions and member versions after later releases.

Writes validate the exact parent Git tree, commit only one pack file, and update main without force. Updates require `expected_digest` from a load. Concurrent changes or stale digests fail with reload/reconcile guidance; a lost ref-update response is checked before any retry. `accepted` identifies a Git commit, not a live release. Status reports active publication separately, including commits incorporated into a newer release. Read back definitions and members after publication.

The existing content-repository publication workflow must include pack validation/building before pack writes can publish. No packs are represented as `SKILL.md` wrappers. A successful load or static schema check is not a completed review: retain selection reasons, actual loads, scope coverage, findings and verification limitations in the review record.
