# Spike 7 Transport Matrix

Generated: 2026-07-02T08:00:27.232Z

Current uid: 1000 (ubuntu)

| Case | Surface | Transport | Outcome | Reason Codes |
| --- | --- | --- | --- | --- |
| cli-foreground-local | cli | cli-local-tty | allow | none |
| cli-foreground-piped | cli | cli-local-nontty | allow | none |
| cli-detached-background-worker | cli | cli-local-nontty | refuse | session_worker_context, detached_context |
| restart-attached-local | cli | cli-local-tty | allow | none |
| mcp-stdio-local | mcp | mcp-stdio | allow | none |
| mcp-local-socket-peercred | mcp | mcp-local-socket-peercred | allow | none |
| mcp-local-socket-no-peercred | mcp | mcp-local-socket-no-peercred | refuse | local_socket_without_peer_credentials, peer_credentials_not_verified, transport_not_allowlisted |
| mcp-network | mcp | mcp-network | refuse | remote_host_configured, network_mcp_transport, transport_not_allowlisted |
| oracle-serve | serve | network-http | refuse | remote_host_configured, network_service_context, transport_not_allowlisted |
| oracle-router | router | network-http | refuse | remote_host_configured, network_service_context, router_context, transport_not_allowlisted |
| oracle-bridge | bridge | network-http | refuse | remote_host_configured, network_service_context, bridge_context, transport_not_allowlisted |
| browser-remote-host | cli | remote-browser-cdp | refuse | remote_browser_configured, remote_browser_cdp, transport_not_allowlisted |
| remote-chrome-devtools | cli | remote-browser-cdp | refuse | remote_chrome_configured, remote_browser_cdp, transport_not_allowlisted |

## Recommended Guard Hooks

- CLI root route/lane resolver before sessionStore.createSession
- restartSession before cloned session creation
- MCP consult before sessionStore.createSession
- detached --exec-session before performSessionRun
- doctor/probe before executable resolution
