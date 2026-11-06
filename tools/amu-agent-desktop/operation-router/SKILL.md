---
name: amu-operation-router
description: Select and coordinate tools before any browser, desktop, service UI, or video-editing workflow in Amu. Re-evaluate on target changes, failures, missing capabilities, or concurrent human/agent activity.
---
# Operation harness
Before acting, identify the requested outcome, exact resource (account/file/tab/window/project), read/write scope, live capabilities, and required evidence. Use operation_route on amu-agent-desktop when exposed; otherwise apply these same rules. Routing never creates authorization. Respect explicit user tool/app choices and higher-priority host instructions.

## Routes
1. Service data: use the service's available purpose-built connector/API if sufficient. Local files: use file/CLI tooling. Do not navigate GUI just to recreate a structured operation.
2. Video editing: creator_open first, keep an editable project, verify in Amu Creator, process comments and resolve only completed ones. If unavailable report exact failure; do not silently substitute CLI-only editing.
3. Web: prefer Amu preview tools. Start preview_status; if closed try preview_open. Match required profile and target tab. Respect human ownership. Use external Chrome DOM/DevTools only if explicitly requested, prescribed by applicable workflow, preview unsupported/absent, or the same step failed twice with evidence. A closed preview alone is not a reason to switch. Do not export cookies to another tool.
4. Native app: prefer agent-desktop semantic observation/action. Read bundled docs and status. Use a fresh qualified ref from the intended app/window. If the semantic action is unavailable and physical input is authorized, use desktop_input within its existing allowlist. Never broaden the allowlist just to satisfy routing.
5. Visual-only controls: Computer Use may be needed after checking capabilities and permissions. Use current screenshots and verify results. Do not promise all apps are controllable, or infer visual quality from an accessibility tree.

## Coordination
- Pin browser tabId/profile and native app/window IDs. Separate agents should use separate tabs or isolated browser contexts; never navigate, close or change another owner's tab.
- DOM operations avoid physical pointer contention but can still race on shared tabs, accounts and server-side data. A shared page-selection API can also race; isolate connections/contexts or serialize the whole workflow.
- Before a multi-step native workflow call desktop_lease acquire on the SAME persistent MCP connection; renew before expiry and release in finally. Default 120 seconds, maximum 300 per renewal. All operations through the adapter are blocked for competing connections while leased.
- The desktop lease does NOT lock Chrome tools, Computer Use, humans, or direct CLI calls. Coordinate those explicitly; never switch tools to evade a busy lease. If another actor is using the same target, wait or choose a genuinely independent resource.
- Tell the user before physical input. Stop when the user starts driving. Human input detection is not implemented. STOP blocks subsequent calls, not an action already dispatched.

## Recovery and proof
- Read after each mutation. Check the actual saved value, reopened document, resulting page or file as appropriate.
- On uncertain delivery/timeouts: observe first, never repeat or fall back with the same mutation blindly. Only retry when disposition.retry is safe AND current state still calls for it.
- On permission denial, report exact denied scope and ask only for the necessary OS step. Do not modify TCC databases. On stale/ambiguous refs, re-observe and narrow the target.
- Re-route after meaningful context change, recording a concise reason in progress updates only when useful. Prefer no extra round-trip when the existing evidence already selects the route.
- Inventory is live: installed configs are not proof a tool is attached. Native tool success, adapter tests and cross-provider integration tests are distinct. Report only what was tested.
