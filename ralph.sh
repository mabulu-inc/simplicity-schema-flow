#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# ralph.sh — The Ralph Loop
#
# Runs Claude Code in a stateless loop. Each iteration gets a fresh session
# that reads PROGRESS.md and TASKS.md to pick up where the last one left off.
#
# Usage:
#   ./ralph.sh              # Run with defaults (10 iterations)
#   ./ralph.sh -n 20        # Run 20 iterations
#   ./ralph.sh -n 0         # Run until all tasks are DONE (unlimited)
#   ./ralph.sh -d 5         # 5-second delay between iterations
#   ./ralph.sh -v           # Verbose — stream Claude output to terminal
#   ./ralph.sh --dry-run    # Print what would happen without running
# ============================================================================

MAX_ITERATIONS=10
DELAY=2
DRY_RUN=false
VERBOSE=false
LOG_DIR=".ralph-logs"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Colors ---
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--iterations) MAX_ITERATIONS="$2"; shift 2 ;;
    -d|--delay)      DELAY="$2"; shift 2 ;;
    -v|--verbose)    VERBOSE=true; shift ;;
    --dry-run)       DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: ./ralph.sh [-n iterations] [-d delay_seconds] [-v] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  -n, --iterations  Max iterations (default: 10, 0 = unlimited)"
      echo "  -d, --delay       Seconds between iterations (default: 2)"
      echo "  -v, --verbose     Stream full Claude output to terminal"
      echo "  --dry-run         Print config and exit"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Setup ---
mkdir -p "$PROJECT_DIR/$LOG_DIR"

# --- Helpers ---
timestamp() { date '+%Y-%m-%dT%H:%M:%S'; }
elapsed() { echo "$(( $(date +%s) - $1 ))"; }

fmt_duration() {
  local secs=$1
  if [[ $secs -lt 60 ]]; then
    echo "${secs}s"
  elif [[ $secs -lt 3600 ]]; then
    echo "$((secs / 60))m $((secs % 60))s"
  else
    echo "$((secs / 3600))h $((secs % 3600 / 60))m"
  fi
}

all_tasks_done() {
  if grep -q '^\- \*\*Status\*\*: TODO' "$PROJECT_DIR/docs/TASKS.md" 2>/dev/null; then
    return 1
  fi
  return 0
}

get_next_task() {
  grep 'Next eligible task:' "$PROJECT_DIR/docs/PROGRESS.md" 2>/dev/null | sed 's/.*: //'
}

count_remaining_tasks() {
  grep -c '^\- \*\*Status\*\*: TODO' "$PROJECT_DIR/docs/TASKS.md" 2>/dev/null || echo "0"
}

count_done_tasks() {
  grep -c '^\- \*\*Status\*\*: DONE' "$PROJECT_DIR/docs/TASKS.md" 2>/dev/null || echo "0"
}

# Mark completed tasks as DONE in TASKS.md based on new commits since iter_start
mark_completed_tasks() {
  local since_ts="$1"
  local task_ids
  task_ids=$(git -C "$PROJECT_DIR" log --oneline --since="@${since_ts}" 2>/dev/null \
    | grep -oE 'T-[0-9]+' | sort -u || true)

  for task_id in $task_ids; do
    local task_num="${task_id#T-}"
    local header="### ${task_id}: "
    # Find the task header line, then update the next Status line from TODO to DONE
    if grep -q "^### ${task_id}:" "$PROJECT_DIR/docs/TASKS.md" 2>/dev/null; then
      local line_num
      line_num=$(grep -n "^### ${task_id}:" "$PROJECT_DIR/docs/TASKS.md" | head -1 | cut -d: -f1)
      if [[ -n "$line_num" ]]; then
        # Find the Status line within the next 5 lines after the header
        local status_line
        status_line=$(sed -n "$((line_num+1)),$((line_num+5))p" "$PROJECT_DIR/docs/TASKS.md" \
          | grep -n '^\- \*\*Status\*\*: TODO' | head -1 | cut -d: -f1)
        if [[ -n "$status_line" ]]; then
          local actual_line=$((line_num + status_line))
          sed -i '' "${actual_line}s/TODO/DONE/" "$PROJECT_DIR/docs/TASKS.md"
          echo -e "  ${GREEN}[$(timestamp)] Marked ${task_id} as DONE in TASKS.md${RESET}"
        fi
      fi
    fi
  done
}

# Monitor the JSON stream log and print activity indicators
monitor_progress() {
  local log_file="$1"
  local pid="$2"
  local last_lines=0
  local last_activity
  last_activity=$(date +%s)
  local last_tool=""

  while kill -0 "$pid" 2>/dev/null; do
    if [[ -f "$log_file" ]]; then
      local current_lines
      current_lines=$(wc -l < "$log_file" 2>/dev/null || echo 0)
      current_lines=$(echo "$current_lines" | xargs)

      if [[ "$current_lines" -gt "$last_lines" ]]; then
        last_activity=$(date +%s)
        local new_count=$((current_lines - last_lines))

        # Read only the new lines from the JSON stream
        local new_lines
        new_lines=$(tail -n "$new_count" "$log_file" 2>/dev/null || true)

        # Detect tool use from JSON stream
        local tool_name
        tool_name=$(echo "$new_lines" | grep -o '"tool_name":"[^"]*"' | tail -1 | sed 's/"tool_name":"//;s/"//' || true)
        if [[ -n "$tool_name" && "$tool_name" != "$last_tool" ]]; then
          last_tool="$tool_name"
          case "$tool_name" in
            Write|Edit)
              local file_path
              file_path=$(echo "$new_lines" | grep -o '"file_path":"[^"]*"' | tail -1 | sed 's/"file_path":"//;s/"//' || true)
              if [[ -n "$file_path" ]]; then
                file_path=$(basename "$file_path")
                printf "\n  ${DIM}[%s]${RESET} ${CYAN}%s${RESET} %s" "$(timestamp)" "$tool_name" "$file_path"
              else
                printf "\n  ${DIM}[%s]${RESET} ${CYAN}%s${RESET}" "$(timestamp)" "$tool_name"
              fi
              ;;
            Read|Glob|Grep)
              printf "\n  ${DIM}[%s]${RESET} ${DIM}%s${RESET}" "$(timestamp)" "$tool_name"
              ;;
            Bash)
              local cmd_hint
              cmd_hint=$(echo "$new_lines" | grep -o '"command":"[^"]*"' | tail -1 | sed 's/"command":"//;s/"//' | cut -c1-60 || true)
              if echo "$cmd_hint" | grep -qi 'test\|vitest' 2>/dev/null; then
                printf "\n  ${DIM}[%s]${RESET} ${YELLOW}Running tests...${RESET}" "$(timestamp)"
              elif echo "$cmd_hint" | grep -qi 'git commit\|git push' 2>/dev/null; then
                printf "\n  ${DIM}[%s]${RESET} ${GREEN}Git: %s${RESET}" "$(timestamp)" "$cmd_hint"
              elif echo "$cmd_hint" | grep -qi 'pnpm\|npm\|turbo' 2>/dev/null; then
                printf "\n  ${DIM}[%s]${RESET} ${CYAN}%s${RESET}" "$(timestamp)" "$cmd_hint"
              else
                printf "\n  ${DIM}[%s]${RESET} ${DIM}$ %s${RESET}" "$(timestamp)" "$cmd_hint"
              fi
              ;;
            *)
              printf "\n  ${DIM}[%s]${RESET} %s" "$(timestamp)" "$tool_name"
              ;;
          esac
        fi

        # Detect assistant text messages (progress updates from Claude)
        local assistant_text
        assistant_text=$(echo "$new_lines" | grep '"type":"assistant"' | grep -o '"content":\[{"type":"text","text":"[^"]*"' | sed 's/.*"text":"//;s/"//' | tail -1 || true)
        if [[ -n "$assistant_text" && ${#assistant_text} -gt 10 && ${#assistant_text} -lt 200 ]]; then
          printf "\n  ${DIM}[%s] Claude: %s${RESET}" "$(timestamp)" "$assistant_text"
        fi

        # Detect errors
        if echo "$new_lines" | grep -q '"type":"error"' 2>/dev/null; then
          local error_msg
          error_msg=$(echo "$new_lines" | grep '"type":"error"' | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"//' | tail -1 || true)
          printf "\n  ${RED}[%s] Error: %s${RESET}" "$(timestamp)" "$error_msg"
        fi

        last_lines=$current_lines
      else
        # No new output — show idle warning after 60s
        local idle_secs=$(( $(date +%s) - last_activity ))
        if [[ $idle_secs -gt 60 && $((idle_secs % 60)) -lt 6 ]]; then
          printf "\n  ${YELLOW}[%s] Idle for %s...${RESET}" "$(timestamp)" "$(fmt_duration $idle_secs)"
        fi
      fi
    fi
    sleep 3
  done
}

# Print a summary of what changed during an iteration
print_iteration_summary() {
  local log_file="$1"
  local start_time="$2"
  local duration
  duration=$(fmt_duration "$(elapsed "$start_time")")

  echo ""
  echo -e "  ${DIM}────────────────────────────────────────${RESET}"
  echo -e "  ${DIM}Duration:${RESET} $duration"

  # Log file size
  if [[ -f "$log_file" ]]; then
    local size
    size=$(wc -c < "$log_file" | xargs)
    local lines
    lines=$(wc -l < "$log_file" | xargs)
    echo -e "  ${DIM}Log:${RESET} $lines lines ($size bytes)"
  fi

  # New git commits
  local new_commits
  new_commits=$(git -C "$PROJECT_DIR" log --oneline --since="@${start_time}" 2>/dev/null || true)
  if [[ -n "$new_commits" ]]; then
    echo -e "  ${GREEN}Commits:${RESET}"
    echo "$new_commits" | while IFS= read -r line; do
      echo -e "    ${GREEN}$line${RESET}"
    done
  else
    echo -e "  ${YELLOW}Commits: (none)${RESET}"
  fi

  # Files changed in last commit
  local changed_files
  changed_files=$(git -C "$PROJECT_DIR" diff --name-only HEAD~1 HEAD 2>/dev/null | head -15 || true)
  if [[ -n "$changed_files" ]]; then
    local file_count
    file_count=$(echo "$changed_files" | wc -l | xargs)
    echo -e "  ${DIM}Files changed: $file_count${RESET}"
    echo "$changed_files" | while IFS= read -r f; do
      echo -e "    ${DIM}$f${RESET}"
    done
  fi

  # Task progress
  local done_count remaining_count
  done_count=$(count_done_tasks)
  remaining_count=$(count_remaining_tasks)
  local next
  next=$(get_next_task)
  echo -e "  ${CYAN}Progress: $done_count done, $remaining_count remaining | Next: $next${RESET}"
  echo -e "  ${DIM}────────────────────────────────────────${RESET}"
}

# --- Pre-flight checks ---
if ! command -v claude &>/dev/null; then
  echo -e "${RED}Error: 'claude' CLI not found. Install Claude Code first.${RESET}"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/docs/PROGRESS.md" ]]; then
  echo -e "${RED}Error: docs/PROGRESS.md not found. Are you in the right project?${RESET}"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/docs/TASKS.md" ]]; then
  echo -e "${RED}Error: docs/TASKS.md not found. Are you in the right project?${RESET}"
  exit 1
fi

# --- Config summary ---
echo -e "${BOLD}=== Ralph Loop ===${RESET}"
echo -e "  Project:    $PROJECT_DIR"
echo -e "  Iterations: $([ "$MAX_ITERATIONS" -eq 0 ] && echo 'unlimited' || echo "$MAX_ITERATIONS")"
echo -e "  Delay:      ${DELAY}s between iterations"
echo -e "  Verbose:    $VERBOSE"
echo -e "  Logs:       $LOG_DIR/"
echo -e "  Next task:  $(get_next_task)"
echo -e "  Tasks:      ${GREEN}$(count_done_tasks) done${RESET} | ${YELLOW}$(count_remaining_tasks) remaining${RESET}"
echo -e "${BOLD}==================${RESET}"

if $DRY_RUN; then
  echo "(dry run — exiting)"
  exit 0
fi

# --- Clean slate: discard any unstaged changes from a crashed iteration ---
if ! git -C "$PROJECT_DIR" diff --quiet 2>/dev/null; then
  echo -e "${YELLOW}[$(timestamp)] Discarding unstaged changes from a previous crashed iteration:${RESET}"
  git -C "$PROJECT_DIR" diff --name-only
  git -C "$PROJECT_DIR" checkout -- .
  echo -e "${GREEN}[$(timestamp)] Clean slate restored.${RESET}"
fi

# Push any unpushed commits from a previous run
if ! git -C "$PROJECT_DIR" diff --quiet origin/main..HEAD 2>/dev/null; then
  echo -e "${CYAN}[$(timestamp)] Pushing unpushed commits from a previous run...${RESET}"
  git -C "$PROJECT_DIR" push origin main
fi

# --- The Loop ---
loop_start=$(date +%s)
iteration=0
while true; do
  iteration=$((iteration + 1))

  # Check iteration limit
  if [[ "$MAX_ITERATIONS" -gt 0 && "$iteration" -gt "$MAX_ITERATIONS" ]]; then
    echo ""
    echo -e "${YELLOW}[$(timestamp)] Reached max iterations ($MAX_ITERATIONS). Stopping.${RESET}"
    break
  fi

  # Check if all tasks are done
  next_task=$(get_next_task)
  if all_tasks_done || [[ "$next_task" == *"none"* ]]; then
    echo ""
    echo -e "${GREEN}[$(timestamp)] All tasks are DONE. Ralph is finished.${RESET}"
    break
  fi
  # Extract task ID (e.g. "T-069") from next_task for log filename
  task_id=$(echo "$next_task" | grep -oE 'T-[0-9]+' | head -1 || echo "unknown")
  log_file="$PROJECT_DIR/$LOG_DIR/${task_id}-$(date '+%Y%m%d-%H%M%S').jsonl"
  iter_start=$(date +%s)

  echo ""
  echo -e "${BOLD}[$(timestamp)] === Iteration $iteration/$([ "$MAX_ITERATIONS" -eq 0 ] && echo '∞' || echo "$MAX_ITERATIONS") — Target: $next_task ===${RESET}"

  PROMPT="You are in Ralph Loop iteration $iteration. Follow the Ralph Loop Boot Sequence exactly as defined in CLAUDE.md. Read PROGRESS.md first, then TASKS.md, then execute the next eligible task using red/green TDD. When done, commit and update PROGRESS.md. Do NOT push to origin — the loop handles that. If blocked, update PROGRESS.md and exit."

  if $VERBOSE; then
    # Stream JSON to both terminal and log file
    if claude --print \
         --verbose \
         --output-format stream-json \
         --max-turns 50 \
         --dangerously-skip-permissions \
         "$PROMPT" 2>&1 | tee "$log_file"; then
      echo -e "${GREEN}[$(timestamp)] Iteration $iteration completed successfully.${RESET}"
    else
      exit_code=${PIPESTATUS[0]}
      echo -e "${RED}[$(timestamp)] Iteration $iteration exited with code $exit_code.${RESET}"
    fi
  else
    # Run in background with progress monitor
    claude --print \
         --verbose \
         --output-format stream-json \
         --max-turns 50 \
         --dangerously-skip-permissions \
         "$PROMPT" \
         > "$log_file" 2>&1 &
    claude_pid=$!

    echo -e "  ${DIM}PID: $claude_pid | Log: $log_file${RESET}"

    # Start progress monitor
    monitor_progress "$log_file" "$claude_pid" &
    monitor_pid=$!

    # Wait for Claude to finish
    if wait "$claude_pid" 2>/dev/null; then
      kill "$monitor_pid" 2>/dev/null; wait "$monitor_pid" 2>/dev/null || true
      echo ""
      echo -e "${GREEN}[$(timestamp)] Iteration $iteration completed successfully.${RESET}"
    else
      exit_code=$?
      kill "$monitor_pid" 2>/dev/null; wait "$monitor_pid" 2>/dev/null || true
      echo ""
      echo -e "${RED}[$(timestamp)] Iteration $iteration exited with code $exit_code.${RESET}"
      if [[ $exit_code -gt 1 ]]; then
        echo -e "${RED}  Possible crash — continuing anyway.${RESET}"
      fi
    fi
  fi

  # Mark completed tasks in TASKS.md based on new commits
  mark_completed_tasks "$iter_start"

  # Print iteration summary
  print_iteration_summary "$log_file" "$iter_start"

  # Push any unpushed commits
  if ! git -C "$PROJECT_DIR" diff --quiet origin/main..HEAD 2>/dev/null; then
    echo -e "${CYAN}[$(timestamp)] Pushing commits to origin...${RESET}"
    git -C "$PROJECT_DIR" push origin main
  fi

  # Brief delay
  sleep "$DELAY"
done

# --- Final Summary ---
total_duration=$(fmt_duration "$(elapsed "$loop_start")")
echo ""
echo -e "${BOLD}=== Ralph Loop Complete ===${RESET}"
echo -e "  Iterations:      $iteration"
echo -e "  Total time:      $total_duration"
echo -e "  Tasks completed: ${GREEN}$(count_done_tasks)${RESET}"
echo -e "  Tasks remaining: ${YELLOW}$(count_remaining_tasks)${RESET}"
echo -e "  Final state:"
grep -A3 '## Current State' "$PROJECT_DIR/docs/PROGRESS.md" | tail -4
echo ""
echo -e "  Logs: $LOG_DIR/"
echo -e "${BOLD}==========================${RESET}"
