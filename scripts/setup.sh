#!/usr/bin/env bash
# One-command public setup for Streamroom with Docker Compose, Caddy (HTTPS) and coturn (TURN).
# Usage: scripts/setup.sh [setup|status|update|stop] [--domain NAME] [--public-ip IP]
#                         [--env-file PATH] [--yes] [--no-start]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmd=setup domain='' public_ip='' env_file="$root/.env" assume_yes=0 start=1

usage() {
  cat <<EOF
Usage: scripts/setup.sh [command] [options]

Commands:
  setup    Ask for the domain, write the env file, start the stack and check it (default)
  status   Show the network shape, port use, health checks and containers; changes nothing
  update   git pull --ff-only, then rebuild and restart
  stop     Stop the stack (keeps volumes and certificates)

Options:
  --domain NAME     Domain friends will open (asked for when missing)
  --public-ip IP    Use this public IPv4 instead of resolving the domain
  --env-file PATH   Env file to read and write (default: .env in the repo root)
  --yes             Don't ask questions; firewall changes default to No
  --no-start        Write the env file only; don't start containers
EOF
}

while (($#)); do
  case "$1" in
    setup|status|update|stop) cmd="$1" ;;
    --domain) domain="${2:?--domain needs a value}"; shift ;;
    --domain=*) domain="${1#*=}" ;;
    --public-ip) public_ip="${2:?--public-ip needs a value}"; shift ;;
    --public-ip=*) public_ip="${1#*=}" ;;
    --env-file) env_file="${2:?--env-file needs a value}"; shift ;;
    --env-file=*) env_file="${1#*=}" ;;
    --yes|-y) assume_yes=1 ;;
    --no-start) start=0 ;;
    -h|--help|help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$env_file" == /* ]] || env_file="$PWD/$env_file"
cd "$root"

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
heading() { printf '\n== %s\n' "$*"; }
indent() { local line; while IFS= read -r line; do printf '  %s\n' "$line"; done; }

ask_yes_no() { # ask_yes_no QUESTION; default No
  local reply
  ((assume_yes)) && return 1
  [[ -t 0 ]] || return 1
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

# ---------- env file ----------

# Let Compose parse quoting, comments, CRLF and interpolation exactly as it will at startup.
# An empty Compose model also works before TURN_SECRET has been generated.
env_get() { # env_get KEY [FILE]
  local file="${2:-$env_file}"
  [[ -f "$file" ]] || return 0
  printf 'services: {}\n' |
    docker compose -f - --env-file "$file" config --environment |
    awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2) }'
}

env_value() { # env_value KEY DEFAULT
  local v
  v="$(env_get "$1")"
  printf '%s' "${v:-$2}"
}

compose() { docker compose --env-file "$env_file" --profile public "$@"; }

# ---------- addresses ----------

is_ipv4() {
  local IFS=. o
  local -a parts
  [[ "$1" =~ ^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$ ]] || return 1
  read -r -a parts <<< "$1"
  for o in "${parts[@]}"; do ((10#$o <= 255)) || return 1; done
}

# Loopback, RFC 1918, CGNAT (100.64/10), link-local, and 0/8: none are reachable from the internet.
is_private_ipv4() {
  local a b
  IFS=. read -r a b _ _ <<< "$1"
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 0
  ((a == 100 && b >= 64 && b <= 127)) && return 0
  ((a == 169 && b == 254)) && return 0
  ((a == 172 && b >= 16 && b <= 31)) && return 0
  ((a == 192 && b == 168)) && return 0
  return 1
}

local_ipv4s() {
  if command -v ip >/dev/null; then
    ip -4 -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }'
  elif hostname -I >/dev/null 2>&1; then
    hostname -I | tr ' ' '\n' | grep -E '^[0-9.]+$'
  fi
}

is_local_ipv4() { local_ipv4s | grep -qxF "$1"; }

public_local_ipv4() {
  local ip
  while read -r ip; do
    if ! is_private_ipv4 "$ip"; then printf '%s' "$ip"; return; fi
  done < <(local_ipv4s)
}

# The source address of the default route. `ip route get` only consults the routing table.
lan_ipv4() {
  command -v ip >/dev/null || return 0
  ip -4 route get 1.1.1.1 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true
}

resolve_ipv4() { getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1; exit }' || true; }

normalize_domain() {
  local d="${1,,}"
  d="${d#http://}"; d="${d#https://}"; d="${d%%/*}"; d="${d%.}"
  printf '%s' "$d"
}

valid_domain() {
  local d="$1" label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  [[ "$d" == localhost ]] && return 0
  ((${#d} <= 253)) || return 1
  [[ "$d" =~ ^($label\.)+$label$ ]] || return 1
  [[ ! "${d##*.}" =~ ^[0-9]+$ ]]
}

# ---------- ports ----------

# Sets net_shape (local|vps|nat), turn_external_ip and lan_ip; fails when DNS isn't ready.
detect_network() {
  local ip
  lan_ip="$(lan_ipv4)"
  turn_external_ip=''
  if [[ "$domain" == localhost ]]; then
    net_shape=local
    say "localhost: a local test. Caddy uses its own certificate authority, and friends can't connect."
    return
  fi
  if [[ -n "$public_ip" ]]; then
    ip="$public_ip"
    say "Public IPv4 (from --public-ip): $ip"
  else
    ip="$(resolve_ipv4 "$domain")"
    if [[ -z "$ip" ]]; then
      say "$domain does not resolve to an IPv4 address yet."
      local candidate
      candidate="$(public_local_ipv4)"
      if [[ -n "$candidate" ]]; then
        say "This server has the public address $candidate on a network interface; that is the likely value."
      else
        say "This machine has no public IPv4 on its interfaces, so it is probably behind a router."
        say "Use the router's public (WAN) address, shown on its admin page."
      fi
      printf 'Error: %s\n' "Point an A record for $domain at this server's public IP, then run this again." >&2
      return 1
    fi
    say "$domain resolves to $ip"
  fi
  is_ipv4 "$ip" || die "No usable IPv4 address found for $domain. An IPv4 A record is required."
  if is_private_ipv4 "$ip"; then
    warn "$ip is a private address; friends outside your network can't reach it, and Let's Encrypt can't issue a certificate."
  fi
  if is_local_ipv4 "$ip"; then
    net_shape=vps
    say "$ip is assigned directly to this machine; TURN_EXTERNAL_IP will stay empty."
  else
    net_shape=nat
    turn_external_ip="$ip"
    say "$ip is not on any interface here, so this machine sits behind NAT (a home router, or a cloud"
    say "provider that maps a public IP, such as AWS or GCP). TURN_EXTERNAL_IP will be $ip."
    say "CGNAT check: if your router's WAN address differs from $ip (often 100.64-100.127.x.x), your ISP"
    say "uses CGNAT and port forwarding cannot work; use a VPS instead."
  fi
}

port_lines() { # what friends must reach, one per line
  local http https turn min max
  http="$(env_value HTTP_PORT 80)" https="$(env_value HTTPS_PORT 443)"
  turn="$(env_value TURN_PORT 3478)" min="$(env_value TURN_MIN_PORT 49160)" max="$(env_value TURN_MAX_PORT 49200)"
  printf '%s\n' "TCP $http (HTTP, certificate issuance)" "TCP $https (HTTPS)" "UDP $https (HTTP/3, optional)" \
    "TCP $turn (TURN)" "UDP $turn (TURN)" "UDP $min-$max (relayed media)"
}

print_ports() {
  if [[ "$net_shape" == nat ]]; then
    local target="${lan_ip:-this machine}"
    say "Forward these ports on your router to $target (or open them in your cloud firewall):"
  else
    say "Open these ports in any firewall in front of this server:"
  fi
  port_lines | indent
  if [[ "$net_shape" == nat && -n "$lan_ip" ]]; then
    local relay
    relay="$(env_value TURN_RELAY_IP '')"
    [[ -z "$relay" ]] && relay="$(local_ipv4s | grep -vE '^(127\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1 || true)"
    if [[ -n "$relay" && "$relay" != "$lan_ip" ]]; then
      warn "coturn relays from $relay, not $lan_ip. Set TURN_RELAY_IP=$lan_ip in $env_file so forwarded media reaches it."
    fi
  fi
}

# listeners tcp|udp PORT: one line per port and process, naming the process when visible.
listeners() {
  local flag=-ltnp
  [[ "$1" == udp ]] && flag=-lunp
  ss -H "$flag" "sport = :$2" 2>/dev/null | awk -v proto="${1^^}" -v p="$2" '
    {
      who = "process not visible"
      if (match($0, /users:\(\("[^"]+"/)) who = "by " substr($0, RSTART + 9, RLENGTH - 10)
      if (!(who in n)) order[++m] = who
      n[who]++; addr[who] = $4
    }
    END {
      for (i = 1; i <= m; i++) {
        w = order[i]
        print proto, p, "on", (n[w] == 1 ? addr[w] : n[w] " addresses"), "(" w ")"
      }
    }'
}

busy_ports() {
  local turn https p
  command -v ss >/dev/null || { warn "ss not found; skipping the port check."; return; }
  turn="$(env_value TURN_PORT 3478)" https="$(env_value HTTPS_PORT 443)"
  {
    for p in "$(env_value HTTP_PORT 80)" "$https" "$(env_value PORT 8080)" "$turn"; do listeners tcp "$p"; done
    for p in "$https" "$turn"; do listeners udp "$p"; done
  } | sort -u
}

check_ports() {
  local lines
  if [[ -n "$(compose ps -q 2>/dev/null)" ]]; then
    say "Streamroom is running; its own containers hold these ports, so the free-port check is skipped."
    return
  fi
  lines="$(busy_ports)"
  if [[ -z "$lines" ]]; then
    say "Ports are free."
  else
    warn "these ports are already in use; Docker will fail to start until they are free (or change them in $env_file):"
    indent <<< "$lines" >&2
  fi
}

# ---------- firewall ----------

firewall_commands() {
  local http https turn min max
  http="$(env_value HTTP_PORT 80)" https="$(env_value HTTPS_PORT 443)"
  turn="$(env_value TURN_PORT 3478)" min="$(env_value TURN_MIN_PORT 49160)" max="$(env_value TURN_MAX_PORT 49200)"
  if command -v ufw >/dev/null && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
    printf 'sudo ufw allow %s\n' "$http/tcp" "$https/tcp" "$https/udp" "$turn/tcp" "$turn/udp" "$min:$max/udp"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    printf 'sudo firewall-cmd --permanent --add-port=%s\n' "$http/tcp" "$https/tcp" "$https/udp" "$turn/tcp" "$turn/udp" "$min-$max/udp"
    echo 'sudo firewall-cmd --reload'
  fi
}

offer_firewall() {
  local cmds line
  cmds="$(firewall_commands)"
  [[ -n "$cmds" ]] || { say "No active ufw or firewalld found."; return; }
  say "A host firewall is active. These commands allow Streamroom's ports:"
  indent <<< "$cmds"
  if ask_yes_no "Run them now with sudo?"; then
    while read -r line; do
      read -r -a argv <<< "$line"
      "${argv[@]}"
    done <<< "$cmds"
  else
    say "Firewall unchanged. Run the commands above yourself if friends can't connect."
  fi
}

# ---------- secrets ----------

new_turn_secret() {
  openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '\n'
}

# Five groups of five characters from an unambiguous 32-letter alphabet: 125 bits.
new_passphrase() {
  local chars='' out='' i
  while ((${#chars} < 25)); do
    chars+="$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789')"
  done
  for i in 0 5 10 15 20; do out+="${out:+-}${chars:i:5}"; done
  printf '%s' "$out"
}

# ---------- env writing ----------

# write_env KEY=VALUE...: rewrites only the lines whose value changes, so every other line,
# including quoted values, stays byte for byte. Does nothing when nothing changes.
write_env() {
  local base="$env_file" kv tmp backup
  local -a changes=()
  [[ -f "$base" ]] || base="$root/.env.example"
  for kv in "$@"; do
    [[ "$(env_get "${kv%%=*}" "$base")" == "${kv#*=}" ]] || changes+=("$kv")
  done
  if [[ -f "$env_file" ]] && ((${#changes[@]} == 0)); then
    chmod 600 "$env_file"
    say "$env_file is already up to date."
    return
  fi
  tmp="$(mktemp "$env_file.XXXXXX")"
  # Values pass through ENVIRON, so awk doesn't interpret backslashes in them.
  SETUP_KVS="$(printf '%s\n' "${changes[@]}")" awk '
    BEGIN {
      n = split(ENVIRON["SETUP_KVS"], kvs, "\n")
      for (i = 1; i <= n; i++) if (kvs[i] != "") {
        k = substr(kvs[i], 1, index(kvs[i], "=") - 1)
        v = substr(kvs[i], index(kvs[i], "=") + 1)
        # Quote literal values for Compose, including dollars and backslashes.
        quoted = ""
        for (j = 1; j <= length(v); j++) {
          c = substr(v, j, 1)
          if (c == "\\" || c == "\"") quoted = quoted "\\"
          quoted = quoted (c == "$" ? "$$" : c)
        }
        want[k] = k "=\"" quoted "\""; order[++m] = k
      }
    }
    {
      line = $0; ending = (sub(/\r$/, "", line) ? "\r" : "")
      sub(/^[ \t]*(export[ \t]+)?/, "", line)
      k = substr(line, 1, index(line, "=") - 1); sub(/[ \t]+$/, "", k)
      if (index(line, "=") > 1 && (k in want)) { if (!(k in done)) print want[k] ending; done[k] = 1; next }
      print
    }
    END { for (i = 1; i <= m; i++) if (!(order[i] in done)) print want[order[i]] }
  ' "$base" > "$tmp"
  if [[ -f "$env_file" ]]; then
    backup="$env_file.bak.$(date +%Y%m%d-%H%M%S)"
    [[ -e "$backup" ]] && backup="$backup-$$"
    (umask 077; set -o noclobber; cat "$env_file" > "$backup")
    say "Backed up the previous file to $backup"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
  say "Wrote $env_file"
}

# ---------- docker ----------

preflight() {
  command -v docker >/dev/null ||
    die "Docker is not installed. Install Docker Engine: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 ||
    die "The Docker Compose plugin is missing. Install it: https://docs.docker.com/engine/install/"
  if ! docker info >/dev/null 2>&1; then
    die "Can't reach the Docker daemon. Start it (sudo systemctl start docker) or add yourself to the docker group, then log in again. Install guide: https://docs.docker.com/engine/install/"
  fi
}

need_env_file() { [[ -f "$env_file" ]] || die "$env_file not found. Run scripts/setup.sh first."; }

wait_for() { # wait_for SECONDS COMMAND...
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

# Require the app response and HTTP 200, rather than accepting redirects or an
# unrelated service on the configured port. Never send these local probes to a proxy.
health_response() {
  curl --noproxy '*' -fsS --write-out '\n%{http_code}\n' "$@" |
    awk '/"ok"[[:space:]]*:[[:space:]]*true/ { ok = 1 } END { exit !(ok && $0 == "200") }'
}

app_health() { health_response --max-time 3 "http://127.0.0.1:$(env_value PORT 8080)/healthz"; }

https_url() {
  local https
  https="$(env_value HTTPS_PORT 443)"
  if [[ "$https" == 443 ]]; then printf 'https://%s' "$domain"; else printf 'https://%s:%s' "$domain" "$https"; fi
}

https_health() {
  local -a insecure=()
  [[ "$domain" == localhost ]] && insecure=(-k)
  health_response --max-time 5 "${insecure[@]}" --resolve "$domain:$(env_value HTTPS_PORT 443):127.0.0.1" "$(https_url)/healthz"
}

# Returns non-zero when a check fails. WAIT is how long to keep retrying each check.
verify() {
  local wait="$1"
  if wait_for "$wait" app_health; then
    say "App health check passed (127.0.0.1:$(env_value PORT 8080))."
  else
    warn "the app did not answer on 127.0.0.1:$(env_value PORT 8080)/healthz."
    compose logs --tail 20 app >&2 || true
    return 1
  fi
  if wait_for "$((wait * 2))" https_health; then
    say "HTTPS through Caddy passed ($(https_url)/healthz)."
  else
    warn "HTTPS through Caddy did not answer at $(https_url)/healthz. Last Caddy log lines:"
    compose logs --tail 20 caddy >&2 || true
    say "The usual cause: TCP ports 80 and 443 aren't reachable from the internet yet, or DNS for $domain"
    say "doesn't point here yet. Fix that and Caddy retries on its own; check with: $(self_cmd status)"
    return 1
  fi
}

self_cmd() {
  local c="scripts/setup.sh $1"
  [[ "$env_file" != "$root/.env" ]] && c+=" --env-file $env_file"
  printf '%s' "$c"
}

# ---------- commands ----------

do_setup() {
  local existing turn_secret passphrase generated=0 port ok=1
  heading "Checking Docker"
  preflight
  say "Docker and Docker Compose are ready."

  existing="$(env_get DOMAIN)"
  if [[ -z "$domain" ]]; then
    if ((assume_yes)) || [[ ! -t 0 ]]; then
      domain="$existing"
      [[ -n "$domain" ]] || die "No domain given. Pass --domain NAME."
    else
      read -r -p "Domain friends will open${existing:+ [$existing]}: " domain
      domain="${domain:-$existing}"
    fi
  fi
  domain="$(normalize_domain "$domain")"
  valid_domain "$domain" || die "'$domain' doesn't look like a domain name (for example stream.example.com)."
  if [[ -n "$public_ip" ]] && ! is_ipv4 "$public_ip"; then die "--public-ip must be an IPv4 address."; fi

  heading "Network"
  detect_network || exit 1

  heading "Env file"
  turn_secret="$(env_get TURN_SECRET)"
  if [[ -z "$turn_secret" || "$turn_secret" == change-me-to-a-long-random-string ]]; then
    turn_secret="$(new_turn_secret)"
    say "Generated a new TURN_SECRET."
  fi
  passphrase="$(env_get HOST_PASSPHRASE)"
  if [[ -z "$passphrase" ]]; then
    passphrase="$(new_passphrase)"
    generated=1
    say "Generated a new HOST_PASSPHRASE."
  fi
  port="$(env_value PORT 8080)"
  # Pin coturn to the address receiving traffic, rather than its first non-Docker
  # interface, which can be a VPN or another unrelated interface.
  local relay_ip
  relay_ip="$(env_get TURN_RELAY_IP)"
  if [[ -z "$relay_ip" ]]; then
    if [[ "$net_shape" == vps ]]; then relay_ip="${public_ip:-$(resolve_ipv4 "$domain")}";
    else relay_ip="$lan_ip"; fi
  fi
  write_env "DOMAIN=$domain" APP_BIND=127.0.0.1 "PORT=$port" "TURN_SECRET=$turn_secret" \
    "HOST_PASSPHRASE=$passphrase" "TURN_EXTERNAL_IP=$turn_external_ip" "TURN_RELAY_IP=$relay_ip"
  compose config -q || die "docker compose rejected $env_file."
  local turn_host
  turn_host="$(env_get TURN_HOST)"
  if [[ -n "$turn_host" && "$turn_host" != "$domain" ]]; then
    say "Note: TURN_HOST is set to $turn_host. Leave it empty to use $domain."
  fi

  heading "Ports"
  check_ports
  print_ports

  heading "Firewall"
  offer_firewall

  if ((start)); then
    heading "Starting"
    compose up -d --build
    heading "Checking"
    verify 60 || ok=0
  else
    say
    say "Skipped starting containers (--no-start). Start them with: $(self_cmd setup)"
  fi

  heading "Summary"
  say "Open:             $(https_url)"
  say "Host passphrase:  $passphrase"
  ((generated)) && say "                  (new; stored as HOST_PASSPHRASE in $env_file)"
  say "Status:           $(self_cmd status)"
  say "Update:           $(self_cmd update)"
  say "Stop:             $(self_cmd stop)"
  ((ok)) || exit 1
}

do_status() {
  need_env_file
  preflight
  domain="$(env_get DOMAIN)"
  [[ -n "$domain" ]] || die "DOMAIN is empty in $env_file. Run scripts/setup.sh first."
  heading "Network"
  detect_network || net_shape=unknown
  heading "Ports"
  print_ports
  local lines
  lines="$(busy_ports)"
  if [[ -n "$lines" ]]; then say "Listening now:"; indent <<< "$lines"; else say "Nothing is listening on Streamroom's ports."; fi
  heading "Containers"
  compose ps
  heading "Checking"
  verify 5
}

case "$cmd" in
  setup) do_setup ;;
  status) do_status ;;
  update)
    need_env_file
    preflight
    git -C "$root" pull --ff-only
    compose up -d --build
    domain="$(env_get DOMAIN)"
    verify 60
    ;;
  stop)
    need_env_file
    preflight
    compose down
    say "Stopped. Volumes (certificates) are kept."
    ;;
esac
