#!/bin/bash
# Open each lark-worker tmux session in a new Terminal.app tab.
# Usage: ./open-workers.sh [--watch]
#   --watch: keep checking for new workers and open tabs automatically

set -euo pipefail

open_tab_for_session() {
  local session="$1"
  osascript <<EOF
tell application "Terminal"
  activate
  tell application "System Events" to keystroke "t" using command down
  delay 0.3
  do script "tmux attach -t $session" in front window
end tell
EOF
}

# Find all lark-worker tmux sessions
sessions=$(tmux ls -F '#{session_name}' 2>/dev/null | grep '^lark-worker-' | sort || true)

if [ -z "$sessions" ]; then
  echo "No lark-worker tmux sessions found. Start the daemon first:"
  echo "  cd ~/feishu-dispatcher/dispatcher && bun run start"
  exit 1
fi

# Track which sessions we've already opened
declare -A opened

# Open existing sessions
for s in $sessions; do
  echo "Opening tab for: $s"
  open_tab_for_session "$s"
  opened["$s"]=1
  sleep 0.5
done

echo "Opened ${#opened[@]} worker tab(s)"

# --watch mode: poll for new workers
if [ "${1:-}" = "--watch" ]; then
  echo "Watching for new workers... (Ctrl+C to stop)"
  while true; do
    sleep 3
    current=$(tmux ls -F '#{session_name}' 2>/dev/null | grep '^lark-worker-' | sort || true)
    for s in $current; do
      if [ -z "${opened[$s]:-}" ]; then
        echo "New worker detected: $s"
        open_tab_for_session "$s"
        opened["$s"]=1
        sleep 0.5
      fi
    done
  done
fi
