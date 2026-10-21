#!/bin/bash
# Launches a Soffa API Logs Dashboard server on EC2: a security group (HTTP
# and HTTPS from anywhere, SSH from your address only), an Ubuntu 24.04 arm64
# instance that sets itself up on first boot (user-data.sh), and an Elastic IP.
#
#   DOMAIN=apiloupe.example.com KEY_NAME=my-key ./deploy/ec2/launch.sh
#
# Needs the aws CLI, logged in with rights to create these. Optional:
# REGION (eu-central-1), VERSION (the release tag), INSTANCE_TYPE (t4g.small),
# NAME (apiloupe), SSH_CIDR (this machine's public address /32).
set -euo pipefail
cd "$(dirname "$0")"

REGION="${REGION:-eu-central-1}"
DOMAIN="${DOMAIN:?set DOMAIN, e.g. apiloupe.example.com}"
KEY_NAME="${KEY_NAME:?set KEY_NAME to an EC2 key pair in $REGION}"
VERSION="${VERSION:-v1.2.0}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
NAME="${NAME:-apiloupe}"
SSH_CIDR="${SSH_CIDR:-$(curl -s https://checkip.amazonaws.com)/32}"
aws() { command aws --region "$REGION" --output text "$@"; }

ami=$(aws ssm get-parameter --query Parameter.Value \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id)
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId')

sg=$(aws ec2 describe-security-groups --query 'SecurityGroups[0].GroupId' \
  --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$vpc")
if [ "$sg" = "None" ]; then
  sg=$(aws ec2 create-security-group --group-name "$NAME" --vpc-id "$vpc" --query GroupId \
    --description "Soffa API Logs Dashboard: HTTP and HTTPS from anywhere, SSH from one address")
  aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
    "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]" \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$SSH_CIDR,Description=ssh}]" > /dev/null
  echo "security group $sg created (SSH from $SSH_CIDR)"
else
  echo "security group $sg reused"
fi

# The first-run setup code: only needed until you create the first admin.
# (pipefail off in here: head closing the pipe early is the point, not an error)
setup_code=$(set +o pipefail; LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' < /dev/urandom | head -c 12 | sed 's/..../&-/g; s/-$//')
userdata=$(mktemp)
trap 'rm -f "$userdata"' EXIT
sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__VERSION__|$VERSION|" -e "s|__SETUP_CODE__|$setup_code|" \
  user-data.sh > "$userdata"

instance=$(aws ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" --security-group-ids "$sg" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2 \
  --user-data "file://$userdata" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId')
echo "instance $instance launching…"
aws ec2 wait instance-running --instance-ids "$instance"

alloc=$(aws ec2 allocate-address --domain vpc --query AllocationId \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]")
aws ec2 associate-address --instance-id "$instance" --allocation-id "$alloc" > /dev/null
ip=$(aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].PublicIp')

cat <<DONE

Soffa API Logs Dashboard server launched
  instance    $instance ($INSTANCE_TYPE, $REGION)
  address     $ip (Elastic IP $alloc)
  setup code  $setup_code

Next:
  1. DNS: add an A record  $DOMAIN  ->  $ip
  2. Wait about 10 minutes while it installs and builds. Progress:
       ssh -i <your key>.pem ubuntu@$ip tail -f /var/log/apiloupe-setup.log
  3. Open https://$DOMAIN (the certificate arrives once DNS resolves),
     enter the setup code, and create the first admin.
DONE
