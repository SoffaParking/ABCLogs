# apiloupe on a single EC2 server

One small instance running everything with Docker Compose: apiloupe,
Postgres, [Caddy](https://caddyserver.com) for HTTPS (certificates from
Let's Encrypt, renewed by themselves), and a nightly database backup.

|            |                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| Instance   | `t4g.small` (2 vCPU, 2 GB, arm64), Ubuntu 24.04, 30 GB encrypted gp3                          |
| Open ports | 80 and 443 from anywhere; 22 from your address only                                           |
| Data       | Postgres in a Docker volume; backups in another (`pg_dump` at 02:30 UTC, 7 kept)              |
| Cost       | about 12 USD a month for the instance, 2.40 for the disk, 3.60 for the address (eu-central-1) |

## Launch

You need the `aws` CLI logged in, an EC2 key pair, and a domain name you can
add a DNS record to.

```sh
DOMAIN=apiloupe.example.com KEY_NAME=my-key ./deploy/ec2/launch.sh
```

It creates a security group, the instance and an Elastic IP, and prints the
address and a setup code. Then:

1. Add a DNS **A record** for your domain pointing at the address.
2. Wait about ten minutes while the server installs Docker and builds
   apiloupe (`ssh ubuntu@<address> tail -f /var/log/apiloupe-setup.log`).
3. Open `https://<your domain>`, enter the setup code and create the first
   admin.

Other settings: `REGION` (default `eu-central-1`), `VERSION` (the release
tag to run), `INSTANCE_TYPE`, `NAME` (for the security group and tags), and
`SSH_CIDR` (default: the public address of the machine running the script).

## Run it

On the server (`ssh ubuntu@<address>`), in `/opt/apiloupe/deploy/ec2`:

```sh
sudo docker compose ps                     # what is running
sudo docker compose logs -f app            # the server's log
sudo docker compose exec app apiloupe-server reset-password --email you@example.com
sudo docker compose exec app apiloupe-import --cloudwatch --log-group /ecs/my-api --since 14d --key alk_...
sudo /opt/apiloupe/deploy/ec2/upgrade.sh v1.0.0   # move to another release
```

The settings are in `/opt/apiloupe/deploy/ec2/.env`, written on first boot:
the domain, the setup code and a random Postgres password that never leaves
the server. `RETENTION_DAYS` is there too.

**Backups** are in the `apiloupe_backups` volume
(`sudo docker compose exec backup ls /backups`). Restore one with:

```sh
sudo docker compose exec -T backup sh -c 'gunzip -c /backups/apiloupe-YYYYMMDD.sql.gz | psql -h db -U apiloupe -d apiloupe'
```

They live on the instance's disk: they cover a broken database or a mistake,
not the loss of the instance. For that, add EBS snapshots (Data Lifecycle
Manager) or copy the backups to S3.

**AWS credentials for CloudWatch imports:** give the instance a role with
`logs:FilterLogEvents` on your log groups. The launch script sets the
metadata hop limit to 2, which lets containers reach the role.
