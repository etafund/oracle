# Generated Lane Surfaces

## Help Lane Section

```text
chatgpt-pro: ChatGPT Pro Extended Reasoning
  command: oracle --lane chatgpt-pro --prompt "$PROMPT" --file PATH... --browser-thinking-time extended --browser-archive auto --browser-attachments auto
  doctor: oracle doctor lane chatgpt-pro --json
gemini-deep-think: Gemini Deep Think
  command: oracle --lane gemini-deep-think --prompt "$PROMPT" --file PATH... --gemini-deep-think --gemini-deep-think-fallback fail
  doctor: oracle doctor lane gemini-deep-think --json
fable-local: Claude Code Fable Local
  command: oracle --lane fable-local --prompt "$PROMPT" --file PATH... --claude-code-no-tools --claude-code-local-only
  doctor: oracle doctor lane fable-local --json
```

## MCP Lane Enum

```json
[
  "chatgpt-pro",
  "gemini-deep-think",
  "fable-local"
]
```

## Capabilities JSON Fragment

```json
[
  {
    "id": "chatgpt-pro",
    "title": "ChatGPT Pro Extended Reasoning",
    "engine": "browser",
    "accessPath": "oracle_browser_remote_or_local",
    "readiness": {
      "doctorCommand": "oracle doctor lane chatgpt-pro --json",
      "requires": [
        "signed_in_chatgpt",
        "pro_model_available",
        "extended_reasoning_selected"
      ]
    },
    "materialDefaults": {
      "browserThinkingTime": "extended",
      "browserArchive": "auto",
      "browserAttachments": "auto",
      "neverClicksAnswerNow": true
    }
  },
  {
    "id": "gemini-deep-think",
    "title": "Gemini Deep Think",
    "engine": "browser",
    "accessPath": "oracle_browser_remote_or_local",
    "readiness": {
      "doctorCommand": "oracle doctor lane gemini-deep-think --json",
      "requires": [
        "signed_in_gemini",
        "deep_think_available",
        "deep_think_selected"
      ]
    },
    "materialDefaults": {
      "fallback": "fail",
      "neverSubstitutesGeminiApi": true
    }
  },
  {
    "id": "fable-local",
    "title": "Claude Code Fable Local",
    "engine": "claude-code",
    "accessPath": "claude_code_subscription_cli",
    "readiness": {
      "doctorCommand": "oracle doctor lane fable-local --json",
      "requires": [
        "local_same_user",
        "subscription_cli_auth",
        "zero_tools_verified"
      ]
    },
    "materialDefaults": {
      "tools": [],
      "localOnly": true,
      "providerBilling": "not_claimed_until_verified"
    }
  }
]
```

## Route-Block Supported Lanes

```json
[
  {
    "lane": "chatgpt-pro",
    "title": "ChatGPT Pro Extended Reasoning",
    "engine": "browser",
    "accessPath": "oracle_browser_remote_or_local",
    "command": "oracle --lane chatgpt-pro --prompt \"$PROMPT\" --file PATH... --browser-thinking-time extended --browser-archive auto --browser-attachments auto",
    "mcp": "{\"lane\":\"chatgpt-pro\",\"prompt\":\"...\",\"files\":[\"PATH\"],\"browserThinkingTime\":\"extended\"}",
    "readiness": {
      "doctorCommand": "oracle doctor lane chatgpt-pro --json",
      "requires": [
        "signed_in_chatgpt",
        "pro_model_available",
        "extended_reasoning_selected"
      ]
    },
    "materialDefaults": {
      "browserThinkingTime": "extended",
      "browserArchive": "auto",
      "browserAttachments": "auto",
      "neverClicksAnswerNow": true
    }
  },
  {
    "lane": "gemini-deep-think",
    "title": "Gemini Deep Think",
    "engine": "browser",
    "accessPath": "oracle_browser_remote_or_local",
    "command": "oracle --lane gemini-deep-think --prompt \"$PROMPT\" --file PATH... --gemini-deep-think --gemini-deep-think-fallback fail",
    "mcp": "{\"lane\":\"gemini-deep-think\",\"prompt\":\"...\",\"files\":[\"PATH\"]}",
    "readiness": {
      "doctorCommand": "oracle doctor lane gemini-deep-think --json",
      "requires": [
        "signed_in_gemini",
        "deep_think_available",
        "deep_think_selected"
      ]
    },
    "materialDefaults": {
      "fallback": "fail",
      "neverSubstitutesGeminiApi": true
    }
  },
  {
    "lane": "fable-local",
    "title": "Claude Code Fable Local",
    "engine": "claude-code",
    "accessPath": "claude_code_subscription_cli",
    "command": "oracle --lane fable-local --prompt \"$PROMPT\" --file PATH... --claude-code-no-tools --claude-code-local-only",
    "mcp": "{\"lane\":\"fable-local\",\"prompt\":\"...\",\"files\":[\"PATH\"]}",
    "readiness": {
      "doctorCommand": "oracle doctor lane fable-local --json",
      "requires": [
        "local_same_user",
        "subscription_cli_auth",
        "zero_tools_verified"
      ]
    },
    "materialDefaults": {
      "tools": [],
      "localOnly": true,
      "providerBilling": "not_claimed_until_verified"
    }
  }
]
```