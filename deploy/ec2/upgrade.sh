#!/bin/bash
# Upgrades this server to another Soffa API Logs Dashboard release:
#   sudo /opt/apiloupe/deploy/ec2/upgrade.sh v1.1.0
# The database migrates itself when the new version starts.
set -euo pipefail
VERSION="${1:?usage: upgrade.sh <version tag, e.g. v1.1.0>}"
cd /opt/apiloupe
git fetch --depth 1 origin "refs/tags/$VERSION:refs/tags/$VERSION"
git checkout -q "$VERSION"
cd deploy/ec2
docker compose up -d --build
docker image prune -f > /dev/null
echo "now on $VERSION"
