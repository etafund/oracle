#!/usr/bin/env python3
# Bundle version: v18.0.0
from __future__ import annotations
import argparse, json, re, subprocess
from pathlib import Path
from datetime import datetime
VERSION='v18.0.0'
SHA_RE=re.compile(r'^sha256:[0-9a-f]{64}$')

def envelope(ok=True, data=None, warnings=None, errors=None, next_command=None, fix_command=None, blocked_reason=None, retry_safe=True):
    return {'ok': ok, 'schema_version': 'json_envelope.v1', 'data': data or {}, 'meta': {'tool':'contract-fixture-smoke','bundle_version':VERSION}, 'warnings': warnings or [], 'errors': errors or [], 'commands': {'next':'python3 scripts/contract-fixture-smoke.py --json'}, 'next_command': next_command, 'fix_command': fix_command, 'blocked_reason': blocked_reason, 'retry_safe': retry_safe}

def load(path: Path): return json.loads(path.read_text(encoding='utf-8'))
def parse_time(value: str): return datetime.fromisoformat(value.replace('Z','+00:00'))
def walk_hashes(obj, errors, where='fixture'):
    if isinstance(obj, dict):
        for k,v in obj.items():
            if isinstance(v, str) and v.startswith('sha256:') and not SHA_RE.match(v): errors.append(f'{where}.{k} is not a full sha256 digest: {v}')
            walk_hashes(v, errors, f'{where}.{k}')
    elif isinstance(obj, list):
        for i,v in enumerate(obj): walk_hashes(v, errors, f'{where}[{i}]')

def main():
    ap=argparse.ArgumentParser(description='Smoke-test v18 contract fixtures and route invariants.')
    ap.add_argument('--json', action='store_true')
    args=ap.parse_args()
    root=Path(__file__).resolve().parents[1]
    errors=[]; warnings=[]; loaded={}
    required=[
      'contracts/provider-access-policy.schema.json','contracts/browser-lease.schema.json','contracts/browser-evidence.schema.json','contracts/model-reasoning-policy.schema.json','contracts/provider-result.schema.json','contracts/provider-route.schema.json','contracts/remote-browser-endpoint.schema.json','contracts/prompt-context-packet.schema.json','contracts/route-readiness.schema.json','contracts/deepseek-search-tool.schema.json','contracts/provider-docs-snapshot.schema.json','contracts/review-quorum.schema.json','contracts/json-envelope.schema.json','contracts/context-serialization-policy.schema.json',
      'fixtures/model-reasoning-policy.json','fixtures/provider-access-policy.json','fixtures/provider-route.balanced.json','fixtures/runtime-budget.json','fixtures/route-readiness.balanced.json','fixtures/review-quorum.balanced.json','fixtures/codex-intake.json','fixtures/interactive-intake.json','fixtures/chatgpt-pro-evidence.json','fixtures/gemini-deep-think-evidence.json','fixtures/provider-result.chatgpt.json','fixtures/provider-result.chatgpt-synthesis.json','fixtures/provider-result.gemini.json','fixtures/provider-result.deepseek.json','fixtures/provider-result.claude.json','fixtures/provider-result.xai.json','fixtures/provider-capability.deepseek.json','fixtures/provider-capability.xai.json','fixtures/provider-capability.claude.json','fixtures/deepseek-search-tool.json','fixtures/provider-docs-snapshot.json','fixtures/prompting-policy.json','fixtures/context-serialization-policy.json','fixtures/negative/deepseek-search-disabled.invalid.json','fixtures/negative/route-readiness-circular-synthesis.invalid.json','docs/highest-reasoning-policy.md','docs/browser-effort-selection-policy.md','docs/route-readiness-and-stage-gates.md','docs/review-quorum-policy.md','docs/synthesis-stage-gating-policy.md','docs/provider-result-consistency-policy.md','docs/toon-rust-context-compression-policy.md']
    for rel in required:
        p=root/rel
        if not p.exists(): errors.append(f'missing required v18 file: {rel}'); continue
        if p.suffix=='.json':
            try:
                obj=load(p); loaded[rel]=obj; walk_hashes(obj, errors, rel)
                if obj.get('bundle_version') and obj.get('bundle_version') != VERSION: errors.append(f'{rel} bundle_version must be {VERSION}')
            except Exception as exc: errors.append(f'failed to parse {rel}: {exc}')
    if list(root.rglob('__pycache__')): errors.append('bundle must not include __pycache__ directories')
    # no old active bundle version markers, except docs may mention v15 in comparison prose? Hard fail exact bundle markers only.
    for p in root.rglob('*'):
        if p.is_file() and p.suffix in {'.md','.json','.py','.sh','.txt'}:
            s=p.read_text(encoding='utf-8', errors='ignore')
            if ('v'+'14.0.0') in s or ('v'+'13.0.0') in s: errors.append(f'stale older-version marker in {p.relative_to(root)}')
    expected={
      'codex_intake': {'reasoning_effort':'xhigh'},
      'codex_thinking_fast_draft': {'reasoning_effort':'xhigh'},
      'chatgpt_pro_first_plan': {'requested_reasoning_effort':'max_browser_available','browser_effort_strategy':'select_highest_visible','effort_rank_required':'highest_visible'},
      'chatgpt_pro_synthesis': {'requested_reasoning_effort':'max_browser_available','browser_effort_strategy':'select_highest_visible','effort_rank_required':'highest_visible'},
      'gemini_deep_think': {'browser_mode':'Deep Think','requested_reasoning_effort':'deep_think_highest_available','api_equivalent_thinking_level':'high'},
      'claude_code_opus': {'effort':'max','claude_code_keyword':'ultrathink'},
      'xai_grok_reasoning': {'model':'grok-4.3','reasoning_effort':'high'},
      'deepseek_v4_pro_reasoning_search': {'model':'deepseek-v4-pro','reasoning_effort':'max','search_enabled':True},
    }
    policy=loaded.get('fixtures/model-reasoning-policy.json',{}); defaults=policy.get('live_provider_effort_defaults',{})
    access=loaded.get('fixtures/provider-access-policy.json',{}); live=access.get('live_routes',{})
    for slot, reqs in expected.items():
        for coll_name, coll in [('model reasoning policy', defaults), ('provider access policy', live)]:
            obj=coll.get(slot)
            if not obj: errors.append(f'{coll_name} missing {slot}'); continue
            for k,v in reqs.items():
                if obj.get(k) != v: errors.append(f'{coll_name} {slot}.{k} expected {v!r}, got {obj.get(k)!r}')
    for slot in ['chatgpt_pro_first_plan','chatgpt_pro_synthesis','gemini_deep_think','claude_code_opus','codex_intake','codex_thinking_fast_draft']:
        if live.get(slot,{}).get('api_allowed') is not False: errors.append(f'{slot} must forbid direct API substitution')
    for slot in ['xai_grok_reasoning','deepseek_v4_pro_reasoning_search']:
        if live.get(slot,{}).get('api_allowed') is not True: errors.append(f'{slot} must be explicit API-allowed route')
    codex=loaded.get('fixtures/codex-intake.json',{})
    if codex:
        if any(codex.get(k)!='xhigh' for k in ['reasoning_effort','model_reasoning_effort','plan_mode_reasoning_effort']): errors.append('codex intake must use xhigh effort fields')
        for k in ['formal_first_plan','eligible_for_synthesis']:
            if codex.get(k) is not False: errors.append(f'codex intake {k} must be false')
    for rel, provider, slot, effort in [('fixtures/chatgpt-pro-evidence.json','chatgpt','chatgpt_pro_first_plan','max_browser_available'),('fixtures/gemini-deep-think-evidence.json','gemini','gemini_deep_think','deep_think_highest_available')]:
        ev=loaded.get(rel,{})
        if not ev: continue
        if ev.get('provider') != provider or ev.get('provider_slot') != slot: errors.append(f'{rel} provider/provider_slot mismatch')
        if ev.get('mode_verified') is not True or ev.get('verified_before_prompt_submit') is not True: errors.append(f'{rel} must verify mode before prompt submit')
        if ev.get('reasoning_effort_verified') is not True or ev.get('requested_reasoning_effort') != effort: errors.append(f'{rel} must verify requested reasoning effort {effort}')
        if ev.get('selected_effort_is_highest_visible') is not True or not ev.get('effort_rank') or not ev.get('available_effort_labels_hash'): errors.append(f'{rel} must record highest-visible effort rank evidence')
        if ev.get('redaction_policy') != 'redacted': errors.append(f'{rel} must use redacted evidence')
        try:
            if parse_time(ev['verified_at']) > parse_time(ev['prompt_submitted_at']): errors.append(f'{rel} verified_at after prompt_submitted_at')
        except Exception as exc: errors.append(f'{rel} timestamp parse failed: {exc}')
    route=loaded.get('fixtures/provider-route.balanced.json',{}); slots={r.get('slot'):r for r in route.get('routes',[])}
    if route:
        for slot in ['chatgpt_pro_first_plan','gemini_deep_think','chatgpt_pro_synthesis']:
            if slot not in route.get('required_slots',[]): errors.append(f'balanced route missing required {slot}')
        if not route.get('review_quorum_policy') or not route.get('review_quorum'): errors.append('provider route missing review quorum policy')
        if slots.get('chatgpt_pro_synthesis',{}).get('invoke_after') != 'compare_and_review_quorum': errors.append('chatgpt_pro_synthesis route must invoke after compare_and_review_quorum')
        for slot in ['gemini_deep_think','claude_code_opus','xai_grok_reasoning','deepseek_v4_pro_reasoning_search']:
            if slots.get(slot,{}).get('quorum_candidate') is not True: errors.append(f'{slot} must be a quorum candidate')
    quorum=loaded.get('fixtures/review-quorum.balanced.json',{})
    if quorum:
        if quorum.get('optional_review_min_successes',0) < 1: errors.append('balanced review quorum must require at least one optional reviewer')
        if 'gemini_deep_think' not in quorum.get('independent_review_required_slots',[]): errors.append('balanced review quorum must require Gemini Deep Think')
        if quorum.get('independent_review_min_total',0) < 2: errors.append('balanced review quorum must require at least two independent reviewers')
    for rel, slot, eff in [('fixtures/provider-result.chatgpt.json','chatgpt_pro_first_plan','max_browser_available'),('fixtures/provider-result.chatgpt-synthesis.json','chatgpt_pro_synthesis','max_browser_available'),('fixtures/provider-result.gemini.json','gemini_deep_think','deep_think_highest_available'),('fixtures/provider-result.deepseek.json','deepseek_v4_pro_reasoning_search','max'),('fixtures/provider-result.claude.json','claude_code_opus','max'),('fixtures/provider-result.xai.json','xai_grok_reasoning','high')]:
        pr=loaded.get(rel,{})
        if not pr: continue
        if pr.get('provider_slot') != slot: errors.append(f'{rel} provider_slot expected {slot}')
        if pr.get('reasoning_effort') != eff: errors.append(f'{rel} reasoning_effort expected {eff}, got {pr.get("reasoning_effort")}')
        if pr.get('status')=='success' and pr.get('synthesis_eligible') is True and pr.get('reasoning_effort_verified') is not True: errors.append(f'{rel} must have reasoning_effort_verified=true')
    deep=loaded.get('fixtures/provider-result.deepseek.json',{})
    if deep:
        if deep.get('reasoning_content_policy')!='transient_tool_replay_hash_only_persisted': errors.append('DeepSeek result must use transient_tool_replay_hash_only_persisted')
        if deep.get('reasoning_content_transient_replay') is not True: errors.append('DeepSeek result must allow transient reasoning_content replay for tool calls')
        if deep.get('reasoning_content_stored') is not False: errors.append('DeepSeek result must not persist raw reasoning_content')
    rr=loaded.get('fixtures/route-readiness.balanced.json',{})
    if rr:
        if rr.get('preflight_ready') is not True or rr.get('synthesis_ready') is not False or rr.get('synthesis_prompt_ready') is not False: errors.append('balanced route readiness must distinguish preflight_ready=true from synthesis_prompt_ready=false/synthesis_ready=false')
        if 'chatgpt_pro_synthesis' in rr.get('synthesis_prompt_blocked_until_evidence_for',[]): errors.append('synthesis prompt gate must not require chatgpt_pro_synthesis evidence before synthesis runs')
        if 'chatgpt_pro_synthesis' not in rr.get('final_handoff_blocked_until_evidence_for',[]): errors.append('final handoff gate must require chatgpt_pro_synthesis evidence')
        if rr.get('review_quorum_ready') is not False: errors.append('preflight review_quorum_ready should be false before reviewers run')
    snap=loaded.get('fixtures/provider-docs-snapshot.json',{})
    if snap:
        for k in ['expires_at','max_age_days','refresh_required_before_live_provider_calls']:
            if k not in snap: errors.append(f'provider-docs snapshot missing {k}')

    # v18 premortem hardening invariants
    fm=loaded.get('fixtures/failure-mode-ledger.json',{})
    if fm:
        modes=fm.get('failure_modes',[])
        if len(modes) < 10: errors.append('failure-mode ledger must contain at least 10 failure modes')
        owners={m.get('owner') for m in modes}
        for owner in ['oracle','apr','vibe-planning','integration','all']:
            if owner not in owners: errors.append(f'failure-mode ledger missing owner {owner}')
    cut=loaded.get('fixtures/live-cutover-checklist.json',{})
    if cut:
        if cut.get('minimum_release_gate') != 'phase_5_balanced_live_dress_rehearsal': errors.append('live cutover checklist must require balanced dress rehearsal')
        if len(cut.get('phases',[])) < 5: errors.append('live cutover checklist must include at least five phases')
    waiver=loaded.get('fixtures/fallback-waiver.json',{})
    if waiver:
        for slot in ['chatgpt_pro_first_plan','chatgpt_pro_synthesis','gemini_deep_think']:
            if slot not in waiver.get('non_waivable_slots',[]): errors.append(f'fallback waiver must mark {slot} non-waivable')
        if waiver.get('must_surface_in_handoff') is not True: errors.append('fallback waivers must surface in handoff')
    progress=loaded.get('fixtures/run-progress.json',{})
    if progress:
        if not (0 <= progress.get('progress_percent', -1) <= 100): errors.append('run progress percent must be 0..100')
        if not progress.get('user_visible_message'): errors.append('run progress must include user_visible_message')

    csp=loaded.get('fixtures/context-serialization-policy.json',{})
    if csp:
        if csp.get('canonical_storage_format') != 'json': errors.append('context-serialization fixture must keep canonical storage as JSON')
        if csp.get('fallback_format') != 'json': errors.append('context-serialization fixture must use JSON fallback')
        if csp.get('default_effective_format') != 'json': errors.append('context-serialization default effective format must be JSON')
        if csp.get('legal_review_required') is not True: errors.append('toon_rust legal review must be required')
        toon=csp.get('toon_rust',{})
        if toon.get('required') is not False: errors.append('toon_rust must remain optional, not required')
        if toon.get('enabled_by_default') is not False: errors.append('toon_rust must not be enabled by default')
        if toon.get('license_review_required') is not True: errors.append('toon_rust fixture must require license review')
        if 'toon' not in toon.get('cli_candidates',[]): errors.append('toon_rust cli_candidates must include toon')
        if 'canonical_artifact_storage_as_toon' not in csp.get('anti_patterns',[]): errors.append('TOON anti-patterns must forbid canonical artifact storage as TOON')
        if 'ungated_or_required_toon_rust_dependency' not in csp.get('anti_patterns',[]): errors.append('TOON anti-patterns must forbid ungated/required toon_rust dependency')

    # Schema validation
    try:
        import jsonschema
        mapping={
          'fixtures/model-reasoning-policy.json':'contracts/model-reasoning-policy.schema.json','fixtures/provider-access-policy.json':'contracts/provider-access-policy.schema.json','fixtures/browser-lease.json':'contracts/browser-lease.schema.json','fixtures/chatgpt-pro-evidence.json':'contracts/browser-evidence.schema.json','fixtures/gemini-deep-think-evidence.json':'contracts/browser-evidence.schema.json','fixtures/provider-result.chatgpt.json':'contracts/provider-result.schema.json','fixtures/provider-result.chatgpt-synthesis.json':'contracts/provider-result.schema.json','fixtures/provider-result.gemini.json':'contracts/provider-result.schema.json','fixtures/provider-result.deepseek.json':'contracts/provider-result.schema.json','fixtures/provider-result.claude.json':'contracts/provider-result.schema.json','fixtures/provider-result.xai.json':'contracts/provider-result.schema.json','fixtures/provider-capability.deepseek.json':'contracts/provider-capability.schema.json','fixtures/provider-capability.xai.json':'contracts/provider-capability.schema.json','fixtures/provider-capability.claude.json':'contracts/provider-capability.schema.json','fixtures/deepseek-search-tool.json':'contracts/deepseek-search-tool.schema.json','fixtures/provider-route.balanced.json':'contracts/provider-route.schema.json','fixtures/route-readiness.balanced.json':'contracts/route-readiness.schema.json','fixtures/review-quorum.balanced.json':'contracts/review-quorum.schema.json','fixtures/codex-intake.json':'contracts/codex-intake.schema.json','fixtures/prompting-policy.json':'contracts/prompt-policy.schema.json','fixtures/provider-docs-snapshot.json':'contracts/provider-docs-snapshot.schema.json','fixtures/failure-mode-ledger.json':'contracts/failure-mode-ledger.schema.json','fixtures/live-cutover-checklist.json':'contracts/live-cutover-checklist.schema.json','fixtures/fallback-waiver.json':'contracts/fallback-waiver.schema.json','fixtures/run-progress.json':'contracts/run-progress.schema.json','fixtures/context-serialization-policy.json':'contracts/context-serialization-policy.schema.json'}
        for fixture, schema in mapping.items():
            if (root/fixture).exists() and (root/schema).exists(): jsonschema.validate(load(root/fixture), load(root/schema))
    except ImportError:
        warnings.append('jsonschema not installed; skipped schema validation')
    except Exception as exc:
        errors.append(f'jsonschema validation failed: {exc}')
    out=envelope(ok=not errors, data={'checked_root':str(root),'error_count':len(errors),'warning_count':len(warnings),'bundle_version':VERSION}, warnings=warnings, errors=[{'error_code':'validation_failed','message':e} for e in errors], next_command=None if not errors else 'python3 scripts/contract-fixture-smoke.py --json', fix_command=None if not errors else 'fix listed fixture/schema invariant violations', blocked_reason=None if not errors else 'contract_fixture_smoke_failed')
    print(json.dumps(out, indent=2, sort_keys=True) if args.json else ('ok' if not errors else '\\n'.join(errors)))
    return 0 if not errors else 1
if __name__=='__main__': raise SystemExit(main())
