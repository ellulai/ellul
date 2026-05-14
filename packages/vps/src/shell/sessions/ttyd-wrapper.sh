#!/bin/bash
SESSION="$1"

case "$SESSION" in
  main)     PORT=7681 ;;
  opencode) PORT=7682 ;;
  claude)   PORT=7683 ;;
  codex)    PORT=7684 ;;
  cursor)   PORT=7685 ;;
  git)      PORT=7687 ;;
  branch)   PORT=7690 ;;
  save)     PORT=7691 ;;
  ship)     PORT=7692 ;;
  undo)     PORT=7693 ;;
  logs)     PORT=7694 ;;
  clean)    PORT=7695 ;;
  *)
    echo "Unknown session: $SESSION"
    exit 1
    ;;
esac

exec /usr/bin/ttyd \
  --base-path /term/$SESSION/ \
  -p $PORT \
  -i 127.0.0.1 \
  -W \
  -t disableLeaveAlert=true \
  -t rightClickSelectsWord=true \
  /usr/local/bin/ellul-launch "$SESSION"