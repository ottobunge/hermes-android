#!/usr/bin/env bash
# Push this repo as ottobunge (same credential-helper dance as simgate's push-main.sh:
# gh's default helper answers as otto-seed28, so every network git command needs the override).
set -euo pipefail
cd /home/otto/repos/personal/hermes-android
H='!f() { echo username=ottobunge; echo "password=$(gh auth token --user ottobunge)"; }; f'
G=(git -c credential.helper= -c credential.https://github.com.helper= -c "credential.https://github.com.helper=$H")
"${G[@]}" push -q origin "${1:-main}"
"${G[@]}" fetch -q origin
echo "pushed: local $(git rev-parse --short HEAD) origin $(git rev-parse --short "origin/${1:-main}")"
