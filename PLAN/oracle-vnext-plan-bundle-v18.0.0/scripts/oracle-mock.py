#!/usr/bin/env python3
# Bundle version: v18.0.0
from __future__ import annotations
import argparse, json, hashlib
VERSION='v18.0.0'
def h(label): return 'sha256:'+hashlib.sha256(label.encode()).hexdigest()
def env(data=None, warnings=None, ok=True, errors=None, next_command=None, fix_command=None, blocked_reason=None, retry_safe=True):
    return {'ok': ok, 'schema_version': 'json_envelope.v1', 'data': data or {}, 'meta': {'tool':'oracle-mock','failure_mode_ledger':'fixtures/failure-mode-ledger.json', 'live_cutover_checklist':'fixtures/live-cutover-checklist.json', 'run_progress':'fixtures/run-progress.json', 'bundle_version': VERSION}, 'warnings': warnings or ['mock output only'], 'errors': errors or [], 'commands': {}, 'next_command': next_command, 'fix_command': fix_command, 'blocked_reason': blocked_reason, 'retry_safe': retry_safe}
def main():
    p=argparse.ArgumentParser(description='Oracle v18 mock for contract development.')
    p.add_argument('argv', nargs='*')
    p.add_argument('--json', action='store_true')
    ns,unknown=p.parse_known_args()
    argv=ns.argv+unknown
    joined=' '.join(argv)
    if not argv or 'capabilities' in argv:
        data={'mock':True,'capabilities':['chatgpt_pro_browser','gemini_deep_think_browser','remote_browser','browser_leases','redacted_evidence','provider_access_policy_aware','does_not_own_deepseek_api_route','highest_reasoning_policy_aware','prompt_payload_format_passthrough','toon_prompt_blocks_passthrough'],'remote_browser':'preferred','api_substitution_for_chatgpt_gemini':False,'does_not_own_toon_encoding_policy':True,'canonical_prompt_hashing':'bytes_as_submitted','bundle_version':VERSION}
    elif 'remote' in argv and 'doctor' in argv:
        data={'mock':True,'remote_browser':{'status':'ready','host_env':'ORACLE_REMOTE_HOST','token_env':'ORACLE_REMOTE_TOKEN','no_plaintext_secrets':True},'bundle_version':VERSION}
    elif 'leases' in argv and ('plan' in argv or 'status' in argv or 'acquire' in argv):
        data={'mock':True,'leases':{'chatgpt':'available','gemini':'available'},'lease_contract':'browser_lease.v1','resource_locks':['browser:shared-profile:chatgpt','browser:shared-profile:gemini'],'remote_browser_endpoint':'remote_browser_endpoint.v1','bundle_version':VERSION}
    elif 'chatgpt' in argv and 'doctor' in argv:
        data={'mock':True,'provider':'chatgpt','mode':'pro_extended_reasoning','model_selector':'Pro','requested_reasoning_effort':'max_browser_available','observed_reasoning_effort_label':'Heavy','effort_rank':'highest_visible','selected_effort_is_highest_visible':True,'available_effort_labels_hash':h('chatgpt-labels'),'reasoning_effort_verified':True,'verified':True,'evidence_required':True,'evidence_schema':'browser_evidence.v1','bundle_version':VERSION}
    elif 'gemini' in argv and 'doctor' in argv:
        data={'mock':True,'provider':'gemini','mode':'deep_think','requested_reasoning_effort':'deep_think_highest_available','observed_reasoning_effort_label':'Deep Think','effort_rank':'deep_think_selected_and_highest_visible','selected_effort_is_highest_visible':True,'available_effort_labels_hash':h('gemini-labels'),'thinking_level_if_exposed':'high','reasoning_effort_verified':True,'verified':True,'evidence_required':True,'evidence_schema':'browser_evidence.v1','bundle_version':VERSION}
    elif 'evidence' in argv and ('verify' in argv or 'validate' in argv):
        data={'mock':True,'evidence_valid':True,'redacted':True,'hash_shape_enforced':True,'bundle_version':VERSION}
    elif 'run' in argv or 'ask' in argv:
        data={'mock':True,'provider_result':{'status':'success','synthesis_eligible':True,'evidence':{'mode_verified':True,'verified_before_prompt_submit':True,'reasoning_effort_verified':True},'reasoning_effort_verified':True,'result_text_sha256':h('mock-output')},'bundle_version':VERSION}
    else:
        out=env(ok=False, errors=[{'error_code':'unsupported_mock_command','message':'Oracle mock only supports capabilities, remote doctor, browser leases plan/status/acquire, provider doctor, evidence verify, and run/ask.'}], next_command='python3 scripts/oracle-mock.py capabilities --json', fix_command='Use one of the documented mock commands in ROBOTS.md', blocked_reason='unsupported_mock_command', retry_safe=True)
        print(json.dumps(out, indent=2, sort_keys=True)); return 2
    print(json.dumps(env(data), indent=2, sort_keys=True)); return 0
if __name__=='__main__': raise SystemExit(main())
