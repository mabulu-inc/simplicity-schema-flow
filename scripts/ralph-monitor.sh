#!/usr/bin/env bash
set -euo pipefail

# ralph-monitor.sh — Watch ralph's progress in real time.
#
# Usage:
#   ./scripts/ralph-monitor.sh           # one-shot status
#   ./scripts/ralph-monitor.sh -w        # watch mode (refresh every 5s)
#   ./scripts/ralph-monitor.sh -w -i 3   # watch mode, refresh every 3s

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DIR="$PROJECT_DIR/docs/tasks"
LOG_DIR="$PROJECT_DIR/.ralph-logs"
WATCH=false
INTERVAL=5

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--watch)    WATCH=true; shift ;;
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ralph-monitor.sh [-w] [-i seconds]"
      echo "  -w, --watch     Continuous refresh"
      echo "  -i, --interval  Refresh interval in seconds (default: 5)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Helpers ---

count_by_status() {
  local status="$1" count=0
  for f in "$TASKS_DIR"/T-*.md; do
    [[ -f "$f" ]] || continue
    grep -q "^\- \*\*Status\*\*: ${status}" "$f" 2>/dev/null && count=$((count + 1))
  done
  echo "$count"
}

get_active_log() {
  # Most recently modified .jsonl in log dir
  ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1
}

get_ralph_pid() {
  pgrep -f "ralph.sh" 2>/dev/null | head -1 || true
}

get_claude_pid() {
  pgrep -f "claude --print.*Ralph Loop" 2>/dev/null | head -1 || true
}

render() {
  local ralph_pid claude_pid active_log
  ralph_pid=$(get_ralph_pid)
  claude_pid=$(get_claude_pid)
  active_log=$(get_active_log)

  local done_count todo_count total
  done_count=$(count_by_status DONE)
  todo_count=$(count_by_status TODO)
  total=$((done_count + todo_count))

  # Progress bar
  local bar_width=30
  local filled=0
  if [[ $total -gt 0 ]]; then
    filled=$(( (done_count * bar_width) / total ))
  fi
  local empty=$((bar_width - filled))
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done
  local pct=0
  if [[ $total -gt 0 ]]; then
    pct=$(( (done_count * 100) / total ))
  fi

  # Status
  local status_label status_color
  if [[ -n "$claude_pid" ]]; then
    status_label="RUNNING"
    status_color="$GREEN"
  elif [[ -n "$ralph_pid" ]]; then
    status_label="BETWEEN ITERATIONS"
    status_color="$YELLOW"
  else
    status_label="STOPPED"
    status_color="$RED"
  fi

  # Current task from active log filename
  local current_task="—"
  if [[ -n "$active_log" ]]; then
    current_task=$(basename "$active_log" | grep -oE 'T-[0-9]+' || echo "—")
  fi

  # Task title
  local task_title=""
  if [[ "$current_task" != "—" ]]; then
    local task_file="$TASKS_DIR/${current_task}.md"
    if [[ -f "$task_file" ]]; then
      task_title=$(head -1 "$task_file" | sed "s/^# ${current_task}: //")
    fi
  fi

  # Latest activity from log
  local last_tool="" last_file="" last_cmd="" idle_secs=0
  if [[ -n "$active_log" && -f "$active_log" ]]; then
    last_tool=$(tail -50 "$active_log" 2>/dev/null | grep -o '"tool_name":"[^"]*"' | tail -1 | sed 's/"tool_name":"//;s/"//' || true)
    last_file=$(tail -50 "$active_log" 2>/dev/null | grep -o '"file_path":"[^"]*"' | tail -1 | sed 's/"file_path":"//;s/"//' || true)
    last_cmd=$(tail -50 "$active_log" 2>/dev/null | grep -o '"command":"[^"]*"' | tail -1 | sed 's/"command":"//;s/"//' | cut -c1-70 || true)

    if [[ -f "$active_log" ]]; then
      local log_mtime
      log_mtime=$(stat -f %m "$active_log" 2>/dev/null || stat -c %Y "$active_log" 2>/dev/null || echo 0)
      idle_secs=$(( $(date +%s) - log_mtime ))
    fi
  fi

  # Recent commits (last 5)
  local recent_commits
  recent_commits=$(git -C "$PROJECT_DIR" log --oneline -5 2>/dev/null || true)

  # Render
  if $WATCH; then
    clear
  fi

  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║          RALPH MONITOR                       ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Status:   ${status_color}${status_label}${RESET}"
  echo -e "  Task:     ${CYAN}${current_task}${RESET} ${task_title}"
  echo -e "  Progress: ${GREEN}${bar}${RESET} ${done_count}/${total} (${pct}%)"
  echo -e "  Done:     ${GREEN}${done_count}${RESET}  Todo: ${YELLOW}${todo_count}${RESET}"
  echo ""

  if [[ -n "$claude_pid" ]]; then
    echo -e "  ${DIM}── Current Activity ──${RESET}"
    if [[ -n "$last_cmd" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
      echo -e "  Command:  ${DIM}${last_cmd}${RESET}"
    elif [[ -n "$last_file" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
      echo -e "  File:     ${DIM}$(basename "$last_file")${RESET}"
    elif [[ -n "$last_tool" ]]; then
      echo -e "  Tool:     ${CYAN}${last_tool}${RESET}"
    fi
    if [[ $idle_secs -gt 10 ]]; then
      local idle_label="${idle_secs}s ago"
      if [[ $idle_secs -gt 60 ]]; then
        idle_label="$((idle_secs / 60))m $((idle_secs % 60))s ago"
      fi
      echo -e "  Last I/O: ${YELLOW}${idle_label}${RESET}"
    fi
    echo ""
  fi

  echo -e "  ${DIM}── Recent Commits ──${RESET}"
  if [[ -n "$recent_commits" ]]; then
    echo "$recent_commits" | while IFS= read -r line; do
      if echo "$line" | grep -qE '^[a-f0-9]+ T-[0-9]+:'; then
        echo -e "  ${GREEN}${line}${RESET}"
      else
        echo -e "  ${DIM}${line}${RESET}"
      fi
    done
  else
    echo -e "  ${DIM}(none)${RESET}"
  fi
  echo ""

  # Iteration logs summary
  if [[ -d "$LOG_DIR" ]]; then
    local log_count
    log_count=$(ls "$LOG_DIR"/*.jsonl 2>/dev/null | wc -l | xargs)
    local today_count
    today_count=$(ls -la "$LOG_DIR"/*.jsonl 2>/dev/null | grep "$(date '+%b %e\|%b  %e')" | wc -l | xargs)
    echo -e "  ${DIM}── Logs ──${RESET}"
    echo -e "  Total: ${log_count} iterations  Today: ${today_count}"
    if [[ -n "$active_log" ]]; then
      local log_size
      log_size=$(wc -c < "$active_log" | xargs)
      local log_lines
      log_lines=$(wc -l < "$active_log" | xargs)
      echo -e "  Active: $(basename "$active_log") (${log_lines} lines, ${log_size} bytes)"
    fi
  fi

  if $WATCH; then
    echo ""
    echo -e "  ${DIM}Refreshing every ${INTERVAL}s — Ctrl+C to exit${RESET}"
  fi
}

if $WATCH; then
  while true; do
    render
    sleep "$INTERVAL"
  done
else
  render
fi
