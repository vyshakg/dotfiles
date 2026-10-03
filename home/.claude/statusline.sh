#!/usr/bin/env bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
sid=$(echo "$input" | jq -r '.session_id // empty')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$used" ]; then
  pct=$(printf '%.0f' "$used")
  [ "$pct" -lt 0 ] 2>/dev/null && pct=0
  [ "$pct" -gt 100 ] 2>/dev/null && pct=100
  filled=$(( pct / 5 ))
  empty=$(( 20 - filled ))
  bar=$(printf '%*s' "$filled" '' | tr ' ' '█')$(printf '%*s' "$empty" '' | tr ' ' '░')
  printf "%s | [%s] %d%%" "$model" "$bar" "$pct"
else
  printf "%s" "$model"
fi
# md-log link (see hooks/md-log.mjs)
state="$HOME/.claude/md-log/$sid.json"
if [ -n "$sid" ] && [ -f "$state" ]; then
  printf " | 🗒 %s" "$(basename "$(jq -r '.file' "$state")")"
fi
