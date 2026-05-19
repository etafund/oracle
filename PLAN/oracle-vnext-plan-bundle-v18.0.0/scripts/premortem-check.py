#!/usr/bin/env python3
# Bundle version: v18.0.0
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
VERSION='v18.0.0'

def env(ok=True, data=None, warnings=None, errors=None, next_command=None, fix_command=None, blocked_reason=None, retry_safe=True):
    return {'ok': ok, 'schema_version': 'json_envelope.v1', 'data': data or {}, 'meta': {'tool':'premortem-check','bundle_version':VERSION}, 'warnings': warnings or [], 'errors': errors or [], 'commands': {'next':'python3 scripts/premortem-check.py --json'}, 'next_command': next_command, 'fix_command': fix_command, 'blocked_reason': blocked_reason, 'retry_safe': retry_safe}

def load(root, rel):
    return json.loads((root/rel).read_text(encoding='utf-8'))

def main():
    ap=argparse.ArgumentParser(description='Validate v18 premortem hardening artifacts.')
    ap.add_argument('--json', action='store_true')
    args=ap.parse_args()
    root=Path(__file__).resolve().parents[1]
    errors=[]
    for rel in ['fixtures/failure-mode-ledger.json','fixtures/live-cutover-checklist.json','fixtures/fallback-waiver.json','fixtures/run-progress.json']:
        if not (root/rel).exists(): errors.append(f'missing {rel}')
    if not errors:
        ledger=load(root,'fixtures/failure-mode-ledger.json')
        modes=ledger.get('failure_modes',[])
        if len(modes) < 10: errors.append('failure-mode ledger must include at least 10 concrete failure modes')
        owners={m.get('owner') for m in modes}
        for required in ['oracle','apr','vibe-planning','integration','all']:
            if required not in owners: errors.append(f'failure-mode ledger missing owner {required}')
        checklist=load(root,'fixtures/live-cutover-checklist.json')
        if len(checklist.get('phases',[])) < 5: errors.append('live cutover checklist must include at least five phases')
        if checklist.get('minimum_release_gate') != 'phase_5_balanced_live_dress_rehearsal': errors.append('minimum release gate must be balanced live dress rehearsal')
        waiver=load(root,'fixtures/fallback-waiver.json')
        for slot in ['chatgpt_pro_first_plan','chatgpt_pro_synthesis','gemini_deep_think']:
            if slot not in waiver.get('non_waivable_slots',[]): errors.append(f'waiver fixture must mark {slot} non-waivable')
        progress=load(root,'fixtures/run-progress.json')
        if not (0 <= progress.get('progress_percent',-1) <= 100): errors.append('progress_percent out of range')
        if not progress.get('user_visible_message'): errors.append('run progress must include user_visible_message')
    out=env(ok=not errors, data={'bundle_version':VERSION,'error_count':len(errors),'checked':['failure-mode-ledger','live-cutover-checklist','fallback-waiver','run-progress']}, errors=[{'error_code':'premortem_validation_failed','message':e} for e in errors], blocked_reason=None if not errors else 'premortem_artifact_validation_failed', next_command=None if not errors else 'python3 scripts/premortem-check.py --json', fix_command=None if not errors else 'fix v18 premortem artifacts')
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0 if not errors else 1
if __name__ == '__main__':
    raise SystemExit(main())
