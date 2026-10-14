---
name: namespaced-status-command
skill: do
description: Copilot namespaced invocation preserves the status argument
tags: [happy-path, regression]
input: /citadel:do status
state: with-campaign
assert-contains:
  - CAMPAIGNS
assert-not-contains:
  - What would you like
  - provide a direction
  - ENOENT
  - TypeError
---

## What This Tests

The user invokes the plugin with `/citadel:do status`. The skill must bind the
trailing `status` request even when skill loading provides no separate argument
field. The prior behavior treated the request as empty and asked for a direction.

## Expected Behavior

1. Remove the leading namespaced command token and preserve `status`.
2. Execute the Tier 0 dashboard route and show campaign information.
3. Do not list skills or ask what `/do` should accomplish.

The shared parser tests cover preview, longer requests, and prefix boundaries.
This scenario checks model behavior; static validation alone does not verify
Copilot's native argument transport.
