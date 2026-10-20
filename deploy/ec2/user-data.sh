#!/bin/bash
# First-boot setup for an Ubuntu 24.04 server running the Soffa API Logs
# Dashboard. launch.sh fills in the three values below and passes this file as
# EC2 user data.
# Progress: /var/log/apiloupe-setup.log on the server.
set -euo pipefail
exec > >(tee -a /var/log/apiloupe-setup.log) 2>&1

DOMAIN="__DOMAIN__"
VERSION="__VERSION__"
SETUP_CODE="__SETUP_CODE__"

echo "Soffa API Logs Dashboard setup: $DOMAIN, $VERSION"

# Swap: building the image needs more than the 2 GB of a small instance.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 docker-buildx git openssl
systemctl enable --now docker

if [ ! -d /opt/apiloupe ]; then
  git clone --branch "$VERSION" --depth 1 https://github.com/emaalouf/apiloupe.git /opt/apiloupe
fi
cd /opt/apiloupe/deploy/ec2

# Secrets are made here and never leave the server.
if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SETUP_CODE=$SETUP_CODE
RETENTION_DAYS=14
ENV
fi

docker compose up -d --build
echo "Soffa API Logs Dashboard setup: done. Open https://$DOMAIN once DNS points here."
