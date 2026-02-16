#!/usr/bin/env bash
# Restart the backend dev server via tmux
tmux send-keys -t ms_server:0.0 C-c
sleep 2
tmux send-keys -t ms_server:0.0 "make run-local" Enter
