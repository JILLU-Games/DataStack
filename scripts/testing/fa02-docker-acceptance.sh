#!/usr/bin/env bash
# Execute only on a GitHub-hosted disposable Linux VM. Never mount production resources.
set -Eeuo pipefail
umask 077
root="$(git rev-parse --show-toplevel)"
cd "$root"
evidence="${FA02_EVIDENCE:?missing evidence path}"
: > "$evidence"
mark(){ printf '%s\n' "$*" | tee -a "$evidence"; }
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RUNNER_OS:-}" == Linux ]] || { mark DATASTACK_DOCKER_HOST_NOT_ISOLATED; exit 1; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 1
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || { mark DATASTACK_DOCKER_HOST_NOT_ISOLATED; exit 1; }
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$(docker context show)")" == unix:///var/run/docker.sock ]] || { mark DATASTACK_DOCKER_HOST_NOT_ISOLATED; exit 1; }
existing="$(docker ps -aq)" || { mark DATASTACK_DOCKER_DAEMON_UNAVAILABLE; exit 1; }
[[ -z "$existing" ]] || { mark DATASTACK_DOCKER_HOST_NOT_ISOLATED; exit 1; }
docker compose version
docker buildx version
df -h "$root"
[[ "$(df -Pk "$root" | awk 'NR==2 {print $4}')" -ge 8388608 ]] || { mark FA02_INSUFFICIENT_DISK; exit 1; }
project="datastack-fa02-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
temp="$(mktemp -d "$RUNNER_TEMP/fa02.XXXXXXXX")"
base_sha=4959b69bb25b46a16509bfc4755d13bad87347a9
baseline="$temp/baseline"
composefile="$root/docker/docker-compose.yml"
override="$temp/compose.override.yml"
builder=''
owned=0
baseline_created=0
candidate_tag="$project-candidate"
baseline_tag="$project-baseline"
dc(){ docker compose --project-name "$project" -f "$composefile" -f "$override" "$@"; }
cleanup(){
  code=$?
  trap - EXIT
  set +e
  bad=0
  if [[ "$owned" == 1 ]]; then
    dc down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || bad=1
    for resource in container volume network; do
      [[ -z "$(docker "$resource" ls -q --filter "label=com.docker.compose.project=$project")" ]] || bad=1
    done
  fi
  if [[ -n "$builder" ]]; then docker buildx rm "$builder" >/dev/null 2>&1 || bad=1; fi
  for tag in "$candidate_tag" "$baseline_tag"; do
    for svc in web ingestion proxy; do
      if docker image inspect "$tag:$svc" >/dev/null 2>&1; then docker image rm "$tag:$svc" >/dev/null 2>&1 || bad=1; fi
    done
  done
  if [[ "$baseline_created" == 1 ]]; then git worktree remove --force "$baseline" >/dev/null 2>&1 || bad=1; fi
  rm -rf -- "$temp" || bad=1
  if [[ "$bad" == 0 ]]; then mark FA02_OWNED_RESOURCE_CLEANUP_PASS; else mark FA02_OWNED_RESOURCE_CLEANUP_FAILED; code=1; fi
  exit "$code"
}
trap cleanup EXIT
mark "FA02_ISOLATION_PASS $(git rev-parse HEAD) $(git rev-parse 'HEAD^{tree}')"
for key in SERVICE_REALBASE64_64_JWT SERVICE_REALBASE64_64_INTERNAL SERVICE_REALBASE64_64_ADMINSESSION SERVICE_REALBASE64_64_ADMININSTALL SERVICE_PASSWORD_64_POSTGRES FA02_ADMIN_PASSWORD; do
  printf -v "$key" '%s' "$(openssl rand -hex 32)"
  export "$key"
  echo "::add-mask::${!key}"
done
export SERVICE_HEX_32_DATABASENAME="fa02_$(openssl rand -hex 8)"
export DATASTACK_INTERNAL_SECRET="$SERVICE_REALBASE64_64_INTERNAL"
export DATASTACK_ADMIN_EMAIL=fa02-admin@example.invalid
export FA02_ADMIN_EMAIL="$DATASTACK_ADMIN_EMAIL"
export FA02_SETUP_KEY="$SERVICE_REALBASE64_64_ADMININSTALL"
export FA02_INTERNAL="$DATASTACK_INTERNAL_SECRET"
export FA02_FIXTURE=1
export DATASTACK_ALLOW_PRIVATE_URLS=false DATASTACK_PROXY_MODE=true DATASTACK_CORS_ORIGINS=http://proxy
write_override(){
  tag="$1"
  cat > "$override" <<EOF
services:
  web:
    image: $tag:web
    restart: "no"
  ingestion:
    image: $tag:ingestion
    restart: "no"
  proxy:
    image: $tag:proxy
    restart: "no"
  postgres:
    restart: "no"
  redis:
    restart: "no"
EOF
  dc config --format json > "$temp/compose.json"
  node - "$temp/compose.json" "$project" "$tag" "$candidate_tag" <<'NODE'
const assert=require('node:assert/strict');
const c=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
assert.deepEqual(Object.keys(c.services).sort(),['ingestion','postgres','proxy','redis','web']);
for(const s of Object.values(c.services)){
  assert.ok(!s.privileged && !s.pid && s.network_mode!=='host' && !s.ports?.length && !s.devices?.length && !s.volumes_from?.length);
  for(const v of s.volumes||[]) assert.equal(v.type,'volume');
}
assert.deepEqual(Object.keys(c.volumes).sort(),['datastack-data','pgdata','redisdata']);
for(const name of ['web','ingestion']){
  const mounts=c.services[name].volumes;
  assert.equal(mounts.length,1);
  assert.equal(mounts[0].source,'datastack-data');
  assert.equal(mounts[0].target,'/app/storage');
  if(process.argv[4]===process.argv[5]) assert.equal(mounts[0].volume?.nocopy,true,'Candidate shared volume must not copy image directories');
}
for(const v of Object.values(c.volumes)) assert.ok(!v.external && v.name.startsWith(process.argv[3]+'_'));
for(const v of Object.values(c.networks)) assert.ok(!v.external && v.name.startsWith(process.argv[3]+'_'));
NODE
}
build_images(){
  local context="$1" tag="$2" kind="$3" svc file
  builder="$project-$kind"
  docker buildx create --name "$builder" --driver docker-container >/dev/null
  docker buildx inspect "$builder" --bootstrap >/dev/null
  for svc in ingestion web proxy; do
    case "$svc" in ingestion) file=server;; *) file="$svc";; esac
    docker buildx build --builder "$builder" --progress=plain --load -t "$tag:$svc" -f "$context/docker/Dockerfile.$file" "$context"
    mark "FA02_IMAGE_VERIFIED $kind $svc $(docker image inspect --format '{{.Id}}' "$tag:$svc")"
  done
  docker buildx rm "$builder" >/dev/null
  builder=''
}
probe(){
  local stage="$1"
  mark "FA02_PROBE_STAGE $stage"
  FA02_STAGE="$stage" dc exec -T -u node -e FA02_STAGE -e FA02_FIXTURE -e FA02_ADMIN_EMAIL -e FA02_ADMIN_PASSWORD -e FA02_SETUP_KEY -e FA02_INTERNAL ingestion node - < "$root/scripts/testing/fa02-runtime-probe.cjs" 2>&1 | tee -a "$evidence"
}
volumes(){
  docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | sort
}
verify_images(){
  local tag="$1" svc id
  for svc in web ingestion proxy; do
    id="$(dc ps -q "$svc")"
    [[ -n "$id" && "$(docker inspect --format '{{.Image}}' "$id")" == "$(docker image inspect --format '{{.Id}}' "$tag:$svc")" ]]
  done
}
health(){
  dc up -d --no-build --wait --wait-timeout 240
  [[ "$(dc ps --status running -q | wc -l)" -eq 5 ]]
  for svc in web ingestion proxy postgres redis; do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q "$svc")")" == healthy ]]
  done
}
write_override "$candidate_tag"
build_images "$root" "$candidate_tag" candidate
owned=1
health
verify_images "$candidate_tag"
mark FA02_FIVE_SERVICES_HEALTHY
volumes > "$temp/volumes-before"
[[ "$(wc -l < "$temp/volumes-before")" == 3 ]]
probe setup
# Prevent Port 3000 flushing while the ACKed ingestion event is queued.
dc stop web
probe queued
dc kill -s SIGKILL ingestion
dc restart redis
for i in $(seq 1 30); do if dc exec -T redis redis-cli ping | grep -qx PONG; then break; fi; sleep 1; done
dc exec -T redis redis-cli --raw LRANGE datastack:buffer:events 0 -1 | grep -Fq '"eventId":"fa02-restart"'
mark FA02_REDIS_AOF_RESTART_QUEUE_PASS
health
probe restarted
probe recovery
# Quiesce fixture writers, back up all PostgreSQL schema and data, restore to another disposable DB.
dc stop proxy web ingestion
dc exec -T postgres pg_dump -U datastack -d "$SERVICE_HEX_32_DATABASENAME" -Fc > "$temp/fixture.dump"
[[ -s "$temp/fixture.dump" ]]
dc exec -T postgres createdb -U datastack fa02_restore
dc exec -T postgres pg_restore --exit-on-error --no-owner -U datastack -d fa02_restore < "$temp/fixture.dump"
for db in "$SERVICE_HEX_32_DATABASENAME" fa02_restore; do
  dc exec -T postgres pg_dump -U datastack -d "$db" --schema-only --no-owner --no-privileges | sed '/^\\restrict /d; /^\\unrestrict /d' > "$temp/$db.schema"
done
cmp "$temp/$SERVICE_HEX_32_DATABASENAME.schema" "$temp/fa02_restore.schema"
cat > "$temp/fingerprint.sql" <<'SQL'
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(row_to_json(t)::text, '''' ORDER BY row_to_json(t)::text), '''')) FROM %I.%I t;', table_name,table_schema,table_name)
FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name \gexec
SQL
for db in "$SERVICE_HEX_32_DATABASENAME" fa02_restore; do
  dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -At -U datastack -d "$db" < "$temp/fingerprint.sql" > "$temp/$db.hash"
done
[[ "$(wc -l < "$temp/$SERVICE_HEX_32_DATABASENAME.hash")" -ge 8 ]]
cmp "$temp/$SERVICE_HEX_32_DATABASENAME.hash" "$temp/fa02_restore.hash"
mark FA02_POSTGRES_BACKUP_RESTORE_PASS
# Exact previous source, actual three baseline images, same disposable volumes, then return to candidate.
git worktree add --detach "$baseline" "$base_sha"
baseline_created=1
[[ "$(git -C "$baseline" rev-parse 'HEAD^{tree}')" == 37bffae18e2abb6d66a1ae7e1cc6599b48593ee1 ]]
build_images "$baseline" "$baseline_tag" baseline
composefile="$baseline/docker/docker-compose.yml"
write_override "$baseline_tag"
health
verify_images "$baseline_tag"
probe verify
volumes > "$temp/volumes-rollback"
cmp "$temp/volumes-before" "$temp/volumes-rollback"
mark FA02_PREVIOUS_BASELINE_ROLLBACK_PASS
dc stop proxy web ingestion
composefile="$root/docker/docker-compose.yml"
write_override "$candidate_tag"
health
verify_images "$candidate_tag"
probe verify
volumes > "$temp/volumes-final"
cmp "$temp/volumes-before" "$temp/volumes-final"
mark FA02_VOLUME_PERSISTENCE_AND_RETURN_TO_CANDIDATE_PASS
mark FA02_DOCKER_RUNTIME_RECOVERY_PASS
