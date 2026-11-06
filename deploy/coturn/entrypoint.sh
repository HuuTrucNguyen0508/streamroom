#!/bin/sh
# Builds coturn's flags from environment variables, then runs it.
# Credentials are time-limited TURN REST credentials signed with TURN_SECRET (no static users).
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_REALM="${TURN_REALM:-streamroom}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

# The address relayed media leaves from. Defaults to this host's first IPv4 address.
RELAY_IP="${TURN_RELAY_IP:-}"
if [ -z "$RELAY_IP" ]; then
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in *:*|127.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;; esac
    RELAY_IP="$ip"; break
  done
fi
[ -n "$RELAY_IP" ] || { echo "Could not detect a relay IP; set TURN_RELAY_IP" >&2; exit 1; }

set -- \
  --listening-port="$TURN_PORT" \
  --min-port="$TURN_MIN_PORT" --max-port="$TURN_MAX_PORT" \
  --relay-ip="$RELAY_IP" \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" \
  --realm="$TURN_REALM" \
  --fingerprint --no-cli --no-tls --no-dtls --no-software-attribute \
  --no-tcp-relay --no-multicast-peers \
  --stale-nonce=600 --user-quota=12 --total-quota=300 \
  --log-file=stdout --simple-log \
  --denied-peer-ip=0.0.0.0-0.255.255.255 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 \
  --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=::1 \
  --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
  --allowed-peer-ip="$RELAY_IP"

# Behind NAT: TURN_EXTERNAL_IP is the public address (coturn advertises it in relay candidates).
if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  set -- "$@" --external-ip="$TURN_EXTERNAL_IP/$RELAY_IP" --allowed-peer-ip="$TURN_EXTERNAL_IP"
fi

echo "coturn: port $TURN_PORT, relay $RELAY_IP, ports $TURN_MIN_PORT-$TURN_MAX_PORT, external ${TURN_EXTERNAL_IP:-none}"
exec turnserver "$@"
