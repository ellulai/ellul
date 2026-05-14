#!/bin/bash
# Pre-install common apt repositories in golden image
#
# Dev tier users don't have sudo access to add-apt-repository,
# so we pre-install the repos they're most likely to need.
# They can then install packages via: sudo ellul-apt-install <pkg>
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "[golden] Pre-installing common apt repositories..."

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list

# Docker CE (CLI only — no daemon needed for dev)
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

# PostgreSQL client
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/postgresql.list

# Update apt cache with new repos
apt-get update -qq

echo "[golden] Common repositories installed"
