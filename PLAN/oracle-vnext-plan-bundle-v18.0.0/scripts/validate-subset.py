#!/usr/bin/env python3
# Bundle version: v18.0.0
from __future__ import annotations
import argparse, json, subprocess, sys, py_compile
from pathlib import Path
VERSION='v18.0.0'

def env(ok=True, data=None, warnings=None, errors=None, next_command=None, fix_command=None, blocked_reason=None):
    return {'ok': ok, 'schema_version': 'json_envelope.v1', 'data': data or {}, 'meta': {'tool':'validate-subset','bundle_version':VERSION}, 'warnings': warnings or [], 'errors': errors or [], 'commands': {'next':'python3 scripts/validate-subset.py --json'}, 'next_command': next_command, 'fix_command': fix_command, 'blocked_reason': blocked_reason, 'retry_safe': True}

def main():
    ap=argparse.ArgumentParser(description='Validate v18 standalone subset bundle.')
    ap.add_argument('--json', action='store_true')
    args=ap.parse_args()
    root=Path(__file__).resolve().parents[1]
    errors=[]; warnings=[]
    required=['VERSION','BUNDLE_VERSION.md','README.md','ROBOTS.md','robots.json','spec.md','contracts/model-reasoning-policy.schema.json','fixtures/model-reasoning-policy.json','docs/highest-reasoning-policy.md','docs/browser-effort-selection-policy.md','docs/route-readiness-and-stage-gates.md','docs/provider-docs-freshness-policy.md','docs/review-quorum-policy.md','docs/synthesis-stage-gating-policy.md','docs/provider-result-consistency-policy.md','contracts/provider-docs-snapshot.schema.json','fixtures/provider-docs-snapshot.json','contracts/review-quorum.schema.json','fixtures/review-quorum.balanced.json','fixtures/provider-result.xai.json','scripts/contract-fixture-smoke.py','contracts/failure-mode-ledger.schema.json','fixtures/failure-mode-ledger.json','contracts/live-cutover-checklist.schema.json','fixtures/live-cutover-checklist.json','contracts/fallback-waiver.schema.json','fixtures/fallback-waiver.json','contracts/run-progress.schema.json','fixtures/run-progress.json','docs/premortem-failure-mode-hardening.md','docs/mock-to-live-cutover-policy.md','docs/degradation-waiver-policy.md','docs/user-experience-failure-policy.md','docs/evidence-attestation-policy.md','docs/integration-pass-policy.md','scripts/premortem-check.py','contracts/context-serialization-policy.schema.json','fixtures/context-serialization-policy.json','docs/toon-rust-context-compression-policy.md']
    for rel in required:
        if not (root/rel).exists(): errors.append(f'missing required file {rel}')
    if (root/'VERSION').exists() and (root/'VERSION').read_text().strip()!=VERSION: errors.append('VERSION file is not v18.0.0')
    for p in root.rglob('*.json'):
        try: json.loads(p.read_text(encoding='utf-8'))
        except Exception as exc: errors.append(f'invalid JSON {p.relative_to(root)}: {exc}')
    for p in root.rglob('*.py'):
        try: py_compile.compile(str(p), doraise=True)
        except Exception as exc: errors.append(f'python syntax error {p.relative_to(root)}: {exc}')
    # py_compile may create __pycache__; remove generated caches before packaging checks.
    for cache in root.rglob('__pycache__'):
        import shutil
        shutil.rmtree(cache, ignore_errors=True)
    for p in root.rglob('*.sh'):
        proc=subprocess.run(['bash','-n',str(p)], capture_output=True, text=True)
        if proc.returncode: errors.append(f'shell syntax error {p.relative_to(root)}: {proc.stderr}')
    if list(root.rglob('__pycache__')): errors.append('__pycache__ directories must not be packaged')
    smoke=root/'scripts/contract-fixture-smoke.py'
    if smoke.exists():
        proc=subprocess.run(['python3',str(smoke),'--json'],cwd=root,capture_output=True,text=True)
        if proc.returncode: errors.append('contract-fixture-smoke failed: '+(proc.stdout or proc.stderr)[-4000:])
    # Active files must not carry stale bundle marker
    for p in root.rglob('*'):
        if p.is_file() and p.suffix in {'.md','.json','.py','.sh','.txt'}:
            txt=p.read_text(encoding='utf-8',errors='ignore')
            if ('v'+'17.0.0') in txt or ('v'+'16.0.0') in txt or ('v'+'14.0.0') in txt or ('vibe_planning.v'+'14') in txt or ('v'+'13.0.0') in txt or ('vibe_planning.v'+'15') in txt: errors.append(f'stale previous-version marker in {p.relative_to(root)}')
    out=env(ok=not errors, data={'checked_root':str(root),'bundle_version':VERSION,'error_count':len(errors)}, warnings=warnings, errors=[{'error_code':'validation_failed','message':e} for e in errors], next_command=None if not errors else 'python3 scripts/validate-subset.py --json', fix_command=None if not errors else 'fix listed validation errors', blocked_reason=None if not errors else 'subset_validation_failed')
    print(json.dumps(out,indent=2,sort_keys=True) if args.json else ('ok' if not errors else '\n'.join(errors)))
    return 0 if not errors else 1
if __name__=='__main__': raise SystemExit(main())
