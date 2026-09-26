# Propagation pass

A scene in the campaign `{{campaign_id}}` has ended. Decide which of the new or changed facts below would plausibly travel to other actors before the next scene, through which catalog channel, with what delay and fidelity. Nothing propagates because it seems obvious; every transfer must go through a channel that the source could realistically use and the recipient could realistically receive.

Prefer few, specific transfers. Distortion and failure are normal outcomes.

## Output

Return ONLY a JSON object: `{ "events": [ { "kind": "transmit|observe|infer", "fact": "<fact id>", "from": { "type": "actor", "id": "..." } | null, "to": { "type": "actor", "id": "..." }, "channel": "<channel id>", "delay": n, "fidelity": "accurate|partial|distorted|false", "variant": "...", "succeeded": true|false, "believed": true|false, "confidence": "low|medium|high", "note": "..." } ] }`.
