# Casting

Create a voice card for a new character in the campaign `{{campaign_id}}`. The harness has already chosen the character's axis values and a display name; your job is to turn them into a specific, playable voice that does not resemble the existing cast.

Do not invent facts about the world, relationships, possessions, or history. The card is style material only.

## Output

Return ONLY a JSON object with these fields: `rhythm`, `register`, `vocabulary`, `sentences`, `humor`, `stress` (object keyed by emotional state), `status_modulation` (object keyed by relationship or status label), `does_not_sound_like` (array), `examples` (4 to 8 short example lines that could not be spoken by any existing cast member), `notes`.
