#!/usr/bin/env bash
set -euo pipefail
key=$(cat /home/x1/.config/vyron/api-key)
agent_key=$(cat /home/x1/.config/vyron/agent-token)
api=http://127.0.0.1:8787
body='{"name":"vyron-test","template":"ubuntu","resources":{"cpu":0.5,"ram":0.5,"disk":10}}'
cleanup() {
  if sudo virsh -c qemu:///system dominfo vyron-test >/dev/null 2>&1; then
    sudo /usr/local/sbin/vyron-provision delete vyron-test >/dev/null
  fi
}
trap cleanup EXIT
cleanup
job=$(curl -fsS -X POST "$api/v1/deployments" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data "$body")
id=$(printf '%s' "$job" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
for _ in $(seq 1 90); do
  result=$(curl -fsS "$api/v1/jobs/$id" -H "Authorization: Bearer $key")
  state=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
  if [[ "$state" != "provisioning" ]]; then
    printf '%s' "$result" | sed -E 's/"initialPassword":"[^"]+"/"initialPassword":"[REDACTED]"/'
    printf '\n'
    [[ "$state" == "running" ]]
    curl -fsS "http://127.0.0.1:8790/v1/vms/vyron-test/metrics" -H "Authorization: Bearer $agent_key"
    printf '\n'
    sleep 2
    curl -fsS "http://127.0.0.1:8790/v1/vms/vyron-test/metrics" -H "Authorization: Bearer $agent_key"
    printf '\n'
    cleanup
    trap - EXIT
    printf '{"name":"vyron-test","status":"deleted"}\n'
    exit 0
  fi
  sleep 2
done
echo 'Provisioning timed out' >&2
exit 1
