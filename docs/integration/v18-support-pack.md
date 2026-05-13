# Oracle v18 Integration Support Pack

This pack is the small handoff reference for the fourth integration pass. It
points APR, vibe-planning, and other consumers at the current Oracle v18
contracts, fixtures, robot surfaces, and privacy rules without copying unsafe
artifacts.

## Source Of Truth

- Plan bundle: `PLAN/oracle-vnext-plan-bundle-v18.0.0/`
- Bundle version: `v18.0.0`
- Oracle implementation map: `docs/v18-implementation-map.md`
- Local fixture conformance: `tests/conformance/v18/`
- Mock route rehearsal: `tests/e2e/oracle-flow.test.ts`
- Robot surface registry coverage: `tests/cli/robotDocs.test.ts`

Run the local contract fixture smoke checks:

```bash
pnpm run test:v18-conformance
```

For a broader Oracle-side regression pass before handoff:

```bash
pnpm vitest run tests/conformance/v18/ tests/oracle/v18/ tests/premortem/v18/
```

## Contract Hashes

These SHA-256 values are for the schema files under
`PLAN/oracle-vnext-plan-bundle-v18.0.0/contracts/`.

| Contract | SHA-256 |
| --- | --- |
| `approval-ledger.schema.json` | `8ad951d743e81ece8c78e9573147e7e69713c5c2d9ac6408e7fe6155b4e86d64` |
| `artifact-index.schema.json` | `c7994882a389fd753a45d052b029427beee12048c841ae5451f9fc338d04502c` |
| `browser-evidence.schema.json` | `313160c31ba381a4c4d330a87a5dfca4afbcdcd87b52fedc5a4522b276f010b2` |
| `browser-lease.schema.json` | `2c44983418943577654857e7fb9ccb3c85dcdf0446b780d7a02387bc36a78496` |
| `browser-session.schema.json` | `f845d6119642dea74451f33817a412b9ab7306b70def5a8b4bcc25d705b7ac9f` |
| `capability-lease.schema.json` | `a15143e234cb8c0e39112f883cc2085df928166bacb1f8c4f9bb3ff92b4793af` |
| `codex-intake.schema.json` | `29fb5e884a96ffd1df8a4148eb12572a70b57fa37f8d4858b7259f8bafe98d06` |
| `context-format.schema.json` | `92c9bbdbe196724a8fb2b9f6914457c6c8c202c6d3d208bdc0342f2717096e4b` |
| `context-serialization-policy.schema.json` | `0ea0f22ba5b9392e9be8acd23cbe1c1940ec3e71b56981d8a446a82f83b09519` |
| `deepseek-search-tool.schema.json` | `931a2058b20926e4b1cab8495e6dcae91b8eecccaeb9928a477b9892ecf3b953` |
| `execution-profile.schema.json` | `5729f01fb70e6ee2a09de00a208ff08303999860b195753cd5b36bd882eadb93` |
| `failure-mode-ledger.schema.json` | `cb904c408050e55dbe6e407121747a81794b724a57cb1aabbd382b9d0ab5cafb` |
| `fallback-waiver.schema.json` | `3e07c92e5aebad2d363a5a04a77f606c7c40662ee7277148aa151c3a75031f8f` |
| `interactive-intake.schema.json` | `a39e301374ba463217cf1c06902c6c7ed5e897e9e456c5a07be827635ff1a227` |
| `json-envelope.schema.json` | `080dc8f346952a7fcf903a3b3fbe2f986af2e296cb648cb743c5e727ed8deead` |
| `live-cutover-checklist.schema.json` | `416a247c235ed98c2745c9725daacb5859ecd90ff0346d83bc0cc035b646172f` |
| `model-reasoning-policy.schema.json` | `aa69e101933a9768ffedc9e0b10e0d8d77fab3d219b361c87540b87c184f7c3b` |
| `plan-artifact.schema.json` | `56560c5cba7f44a1b887219e46144eb33b75e881a90e64dc7f19c92b35cb4c20` |
| `prompt-context-packet.schema.json` | `1d31501dabbf7b31fc7489888b1b3587e377e8c0128335e711bfa1365460277a` |
| `prompt-manifest.schema.json` | `ebcf95f72175be459daa34367a80898ba985f05b4038d14e0bce845ce4cb684a` |
| `prompt-policy.schema.json` | `1dbc06e71781cec3d8326010263a9ad56ae773556977590bad996298bea79119` |
| `provider-access-policy.schema.json` | `161c7f485cedaf47e26321fd9aaab23674a4d88f4194012ffab4f6ab864c08f4` |
| `provider-capability.schema.json` | `66aee0aaa385aaa106cc091074eebccdae614288a17ac2adc1cc6dfd7a9df835` |
| `provider-docs-snapshot.schema.json` | `066f3e1fafd83fe66cf43473001c9361e3223ff3266f374a589acc367e719a2b` |
| `provider-result.schema.json` | `a2072b42c5d3986be49a71b1af6dc8c185fdf665257d9153b73d58357674ded8` |
| `provider-route.schema.json` | `4441844ab71d626fd55bf24a066ee2a00e9525675024906880156e69141c31e4` |
| `remote-browser-endpoint.schema.json` | `191aed636edeee26933b8986b93bc38719c6617d411bb65b622c6adfcc311961` |
| `review-quorum.schema.json` | `ca5776f27f1fa360cc2b64820f7a9cada784fe8fdaa9c4cc93d5adbe8e20a993` |
| `robot-surface.schema.json` | `17bc8a7ca0baa261b113863e7df586fde344cd3cd7652c195f0f8066a55687df` |
| `route-readiness.schema.json` | `da656b50da4ba082042c4798c8d2a351f611ab2d0db55c5b8325a7305ba4287a` |
| `run-progress.schema.json` | `1638f54f2d1f775c38e7baa6c25549ac155b94b380b4433a2680126418845a64` |
| `runtime-budget.schema.json` | `62ce6761302ca0e18c0f4bfbabd40cdf05b70583fe2a65b3e9b87d91b694b360` |
| `source-baseline.schema.json` | `d461cbae1981e61590aac524983ee9e0a613b74eab283362c0ced99463392cfd` |
| `source-trust.schema.json` | `effbc1be3e3c02fcc581544156d6ab0956691c4a2fb550fb6103b97ae1a93194` |
| `traceability.schema.json` | `807978d45841eb1f4f01a62fead3b0b17fb457b0e4feb82a42751d77cdd1edef` |

To recompute:

```bash
sha256sum PLAN/oracle-vnext-plan-bundle-v18.0.0/contracts/*.schema.json
```

## Fixture And Sample Map

| Need | Safe sample |
| --- | --- |
| JSON envelope success shape | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/json-envelope.ok.json` |
| Redacted ChatGPT browser evidence | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/chatgpt-pro-evidence.json` |
| Redacted Gemini browser evidence | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/gemini-deep-think-evidence.json` |
| ChatGPT provider result | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/provider-result.chatgpt.json` |
| Gemini provider result | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/provider-result.gemini.json` |
| Synthesis provider result | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/provider-result.chatgpt-synthesis.json` |
| Route readiness | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/route-readiness.balanced.json` |
| Provider capability | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/provider-capability.claude.json` |
| Review quorum policy | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/review-quorum.balanced.json` |
| Waiver policy | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/fallback-waiver.json` |
| Live cutover checklist | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/live-cutover-checklist.json` |
| Run progress blocker shape | `PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/run-progress.json` |

Safe evidence samples store hashes and provenance only. They must not carry raw
cookies, raw DOM, raw screenshots, auth headers, account identifiers, raw prompt
text, or raw output text.

## Robot Commands For Consumers

Use the robot commands as integration probes before replacing mocks with live
routes:

```bash
oracle robot-docs --json
oracle capabilities --json
oracle doctor --json
oracle remote doctor --json
oracle browser leases plan --providers chatgpt,gemini --json
oracle browser leases status --json
```

Evidence handoff should use the sanitized export path:

```bash
oracle evidence ledger export <session> --sanitized --json
oracle evidence ledger verify <session> --json
```

Expected healthy robot shape:

```json
{
  "schema_version": "json_envelope.v1",
  "ok": true,
  "data": {},
  "errors": [],
  "warnings": [],
  "blocked_reason": null,
  "next_command": null,
  "fix_command": null,
  "retry_safe": true
}
```

Expected blocker shape:

```json
{
  "schema_version": "json_envelope.v1",
  "ok": false,
  "blocked_reason": "live_provider_approval_required",
  "errors": [{ "error_code": "provider_unavailable", "message": "..." }],
  "next_command": "oracle remote doctor --json",
  "fix_command": null,
  "retry_safe": true
}
```

Consumers should branch on `ok`, `blocked_reason`, `errors[].error_code`,
`next_command`, `fix_command`, and `retry_safe`; do not parse human text.

## Route Readiness And Cutover Status

Current fixture state is preflight-ready but not live-ready:

- `route-readiness.balanced.json` has `ready: true` for `ready_scope:
  preflight`.
- `mock_mode: true` means mocks are still acceptable for preflight rehearsal
  only.
- `synthesis_prompt_ready: false` and `synthesis_ready: false` until normalized
  provider results, comparison, review quorum, and required browser evidence are
  present.
- `run-progress.json` models the blocker as
  `blocked_reason: live_provider_approval_required` with
  `next_command: oracle remote doctor --json`.
- `live-cutover-checklist.json` requires `phase_5_balanced_live_dress_rehearsal`
  before user-facing release.

## APR And Consumer Notes

- Oracle owns browser/API execution surfaces, provider capability reporting,
  browser leases, redacted evidence emission, evidence ledger verification, and
  `json_envelope.v1` robot recovery fields.
- APR owns route orchestration, provider-result comparison, review quorum
  adjudication, waiver recording, and handoff packet assembly.
- Vibe-planning owns route planning and mock/live cutover orchestration.
- Oracle does not own `toon_rust` internals; it only passes TOON prompt blocks
  through as typed prompt blocks.
- Oracle does not own the DeepSeek search adapter; the capability registry marks
  that route unsupported by Oracle and owned by APR.
- Protected browser routes must not silently fall back to API substitutions.
  Return a blocked or degraded envelope when the required subscription/browser
  route cannot be verified.
- Required non-waivable slots are `chatgpt_pro_first_plan`,
  `chatgpt_pro_synthesis`, and `gemini_deep_think`.
- Provider results must preserve `provider_result_id`, `provider_slot`,
  `evidence_id`, `prompt_manifest_sha256`, `source_baseline_sha256`,
  `result_text_sha256`, and `synthesis_eligible`.
- Evidence links must point from `provider_result.v1` to `browser_evidence.v1`
  and preserve hash equality between evidence output and provider result output.
- Default handoff artifacts must be sanitized. Attach raw session directories
  only through an explicit unsafe-artifact review path.

