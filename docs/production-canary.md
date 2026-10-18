# Read-only production canary

Run `node scripts/production-canary.mjs` with Node.js 24. It needs no package
installation, Cloudflare credentials, publisher token or deployment step.
The command uses the runtime's inventory parser and the modern MCP protocol.

| Configuration | Required value |
| --- | --- |
| `GISUL_CANARY_MCP_URL` | Deployed HTTPS `/mcp` endpoint |
| `GISUL_CANARY_READER_TOKEN` | Reader credential accepted by that endpoint |
| `GISUL_CANARY_EXPECTED_RUNTIME` | Full verified source commit reported by the deployed runtime |
| `GISUL_CANARY_INVENTORY_URL` | Independently retained expected `inventory.json`, not a current-pointer lookup |
| `GISUL_CANARY_INVENTORY_SHA256` | `sha256:` digest of the exact expected inventory bytes |
| `GISUL_CANARY_INVENTORY_TOKEN` | Optional separate read credential for a protected expected snapshot |
| `GISUL_CANARY_RECEIPT` | Optional output path; defaults to checkout `dist/receipts/production-canary.json` |

Only loopback HTTP is accepted for local fixture verification. URLs cannot
contain credentials, query or fragment, and redirects are refused. The MCP
reader credential is never sent to the inventory host. Use the separate
inventory credential for private snapshots; this check does not publish an
inventory or require making a private catalog public.

The canary verifies the expected bytes before contacting MCP, the exact runtime
commit, the active skill catalog, each pinned skill manifest and every text or
binary resource. When the inventory declares native packs, it checks their
complete paginated catalog, verified individual loads and member identities.
Runtime identity is the reported serverInfo version, not an independent
attestation of the deployed binary.
An active-catalog recheck prevents pinned reads from hiding a pointer change.
Requests are restricted to discovery and reads, including only `search_packs`
and `load_pack` tool calls; no `/admin` or skill/pack write call is made.

Success and configuration, inventory, HTTP or MCP failures retain a JSON receipt;
failure exits 1. Receipts contain identities, counts and the failed operation,
not skill bodies or HTTP error bodies. Configured reader and inventory tokens
are redacted from string fields. This establishes machine-reader delivery,
not an OAuth member login, model quality or publication authorization.
`scripts/smoke-team.mjs` remains the separate OAuth discovery smoke.

## GitHub Actions

Configure matching repository variables/secrets for the names above. Scheduled
runs are opt-in through variable `GISUL_CANARY_ENABLED=true`; manual dispatch
also runs the check. Both retain receipts even when preflight fails. The job
has only `contents: read`, no publication credential and no activation step.
It uses GitHub Actions failure notifications; no Slack/webhook is configured.

After an independently verified runtime or content release, an operator must
refresh the expected source commit, retained inventory URL and digest. Neither
the publisher nor this canary silently updates that baseline. An old baseline
failing after an intended release is deliberate. No schedule, repository
variable, secret or production endpoint is configured by adding this workflow.
