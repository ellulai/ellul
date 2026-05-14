# PATH exports BEFORE interactive check - needed for tmux/ttyd commands
export PATH="__SVC_HOME__/.node/bin:__SVC_HOME__/.opencode/bin:__SVC_HOME__/.local/bin:$PATH"

case $- in
    *i*) ;;
      *) return;;
esac

HISTCONTROL=ignoreboth
HISTSIZE=10000
HISTFILESIZE=20000
shopt -s histappend
shopt -s checkwinsize

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

export PATH="$HOME/.local/bin:$PATH"

[ -f ~/.ellul-cli-env ] && source ~/.ellul-cli-env

# Lazy AI shims (fallback for non-login shells where /etc/profile.d is not sourced)
[ -f /etc/profile.d/99-lazy-ai-shims.sh ] && source /etc/profile.d/99-lazy-ai-shims.sh

alias c='clear'
alias projects='cd ~/projects'

alias reload='source ~/.ellul-cli-env && echo "CLI keys reloaded"'

cd ~/projects 2>/dev/null || true
