#!/bin/bash
SESSION="$1"
CONTEXT_FILE="__SVC_HOME__/.ellul/context/world.md"
export PATH="__SVC_HOME__/.node/bin:__SVC_HOME__/.opencode/bin:__SVC_HOME__/.local/bin:$PATH"

# Load NVM so npm-installed CLIs (claude, codex) are in PATH
export NVM_DIR="__SVC_HOME__/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Load lazy-ai shims (shows "installing..." instead of "command not found")
[ -f /etc/profile.d/99-lazy-ai-shims.sh ] && . /etc/profile.d/99-lazy-ai-shims.sh


refresh_context() {
  /usr/local/bin/ellul-ctx >/dev/null 2>&1 || true
}

case "$SESSION" in
  main)
    exec tmux new-session -A -s main
    ;;
  opencode)
    refresh_context
    exec tmux new-session -A -s opencode "cd __SVC_HOME__/projects && opencode; exec bash"
    ;;
  claude)
    refresh_context
    exec tmux new-session -A -s claude "cd __SVC_HOME__/projects && claude; exec bash"
    ;;
  codex)
    refresh_context
    exec tmux new-session -A -s codex "cd __SVC_HOME__/projects && codex; exec bash"
    ;;
  cursor)
    refresh_context
    exec tmux new-session -A -s cursor "cd __SVC_HOME__/projects && cursor-agent; exec bash"
    ;;
  git)
    exec tmux new-session -A -s git "cd __SVC_HOME__/projects && lazygit; exec bash"
    ;;
  save)
    exec tmux new-session -A -s save "ellul-ai-flow save; exec bash"
    ;;
  ship)
    exec tmux new-session -A -s ship "ellul-ai-flow ship; exec bash"
    ;;
  branch)
    exec tmux new-session -A -s branch "cd __SVC_HOME__/projects && ellul-git-flow branch; exec bash"
    ;;
  undo)
    exec tmux new-session -A -s undo "ellul-undo; exec bash"
    ;;
  logs)
    exec tmux new-session -A -s logs "echo -e '\033[32mLIVE LOGS - Press Ctrl+C to exit\033[0m' && pm2 logs --lines 50; exec bash"
    ;;
  clean)
    exec tmux new-session -A -s clean "sudo ellul-clean; exec bash"
    ;;
  *)
    echo "Unknown: $SESSION"
    exec tmux new-session -A -s main
    ;;
esac
