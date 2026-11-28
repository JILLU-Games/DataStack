/* Standalone synthetic integration probe, executed only inside the run-owned ingestion service. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const Redis = require('ioredis');
const { parse } = require('csv-parse/sync');
const { Parser } = require('json2csv');

const base = 'http://proxy';
const stage = process.env.FA02_STAGE;
const stateFile = '/app/storage/.fa02-state.json';
const clientId = 'fa02-runtime-fixture';
const fixtureRoot = path.join('/app/storage/data', clientId);
const queue = 'datastack:buffer:events';
const ids = ['fa02-http','fa02-ws','fa02-restart','fa02-replay-new'];
const text = 'fixture, "quoted"\nsecond line';
let state, cookie;
const redis = new Redis('redis://redis:6379', { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on('error', () => {});
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function request(route, { method='GET', body, raw, token, authenticated=false, status=200, origin=base, internal=false }={}) {
  const headers = { Origin: origin };
  if (authenticated) headers.Cookie=cookie;
  if (token) headers.Authorization='Bearer '+token;
  if (internal) headers['x-datastack-internal-secret']=process.env.DATASTACK_INTERNAL_SECRET || process.env.FA02_INTERNAL;
  if (body!==undefined) headers['Content-Type']='application/json';
  const res=await fetch((internal?'http://ingestion:4000':base)+route,{method,headers,body:body!==undefined?JSON.stringify(body):raw,redirect:'manual',signal:AbortSignal.timeout(15000)});
  check(res.status===status, method+' '+route.split('?')[0]+' expected '+status+' got '+res.status);
  return res;
}
async function login() {
  const r=await request('/api/auth/login',{method:'POST',body:{email:process.env.FA02_ADMIN_EMAIL,password:process.env.FA02_ADMIN_PASSWORD}});
  const c=r.headers.get('set-cookie') || '';
  check(c.includes('datastack_admin_session='),'Missing session cookie');
  cookie=c.split(';')[0];
}
async function wsConnect(token, expectSuccess=true) {
  return new Promise((resolve,reject)=>{
    const socket=io(base,{path:'/socket.io/',transports:['websocket'],auth:{token},reconnection:false,timeout:8000,forceNew:true});
    const timer=setTimeout(()=>{socket.close();reject(new Error('WebSocket handshake timeout'));},10000);
    socket.once('connect',()=>{clearTimeout(timer);if(!expectSuccess){socket.close();reject(new Error('Invalid WebSocket authenticated'));}else resolve(socket);});
    socket.once('connect_error',()=>{clearTimeout(timer);socket.close();if(expectSuccess)reject(new Error('Valid WebSocket authentication failed'));else resolve(null);});
  });
}
async function sendWs(id, data, duplicate=false) {
  const socket=await wsConnect(state.token);
  try {
    const ack=await socket.timeout(10000).emitWithAck('sync_data',{eventId:id,timestamp:state.ts,data});
    check(ack?.success===true && ack.eventId===id,'WebSocket ACK failed: '+id);
    if(duplicate) check(ack.note==='DUPLICATE_DROPPED','Duplicate ACK did not identify replay');
  } finally {socket.close();}
}
async function rows(flush=true) {
  const res=await request('/api/export?format=json&clientId='+clientId+'&flush='+flush,{authenticated:true});
  const data=await res.json(); check(Array.isArray(data),'Export not an array'); return data;
}
async function verifyRows(count, flush=true) {
  const data=await rows(flush);
  assert.deepEqual(data.map(x=>x.eventId).sort(),ids.slice(0,count).sort(),'Wrong event identities/counts');
  for(const x of data) {
    check(x.clientId===clientId,'Wrong client');
    check(x.payload?.text===text,'Payload changed or multiline record damaged');
  }
}
async function marker() {
  const url='/vcon/files-engine/fs/'+clientId+'/extracted/marker-renamed.txt?download';
  const res=await request(url,{authenticated:true}); assert.equal(await res.text(),'fa02-volume-marker\n');
}
async function setup() {
  check(!fs.existsSync(stateFile),'Fixture state unexpectedly exists');
  await request('/api/clients',{status:401});
  await request('/api/auth/setup',{method:'POST',body:{email:process.env.FA02_ADMIN_EMAIL,password:process.env.FA02_ADMIN_PASSWORD,setupKey:process.env.FA02_SETUP_KEY}});
  await login();
  await request('/api/clients',{authenticated:true});
  await request('/api/clients',{method:'POST',authenticated:true,origin:'https://invalid.example',body:{clientId:'forbidden',name:'Forbidden'},status:403});
  await request('/api/settings',{method:'POST',authenticated:true,body:{batchFlushIntervalMs:60000,batchFlushThreshold:50000,autoPruneDays:0,compressAfterDays:0,enableIdempotency:true}});
  const r=await request('/api/clients',{method:'POST',authenticated:true,body:{clientId,name:'FA02 synthetic runtime',rateLimit:1000},status:201});
  const created=await r.json(); check(typeof created.client?.token==='string'&&created.client.token.length>20,'Missing client token');
  state={token:created.client.token,ts:new Date().toISOString()};
  fs.writeFileSync(stateFile,JSON.stringify(state),{flag:'wx',mode:0o600});
  await request('/api/events',{method:'POST',token:'invalid',body:{eventId:'rejected',data:{text}},status:401});
  const http=await request('/api/events',{method:'POST',token:state.token,body:{eventId:ids[0],timestamp:state.ts,data:{text}}});
  check((await http.json()).success===true,'HTTP ingestion rejected');
  await wsConnect('invalid',false);
  await sendWs(ids[1],{text});
  await sendWs(ids[1],{text},true);
  await verifyRows(2);
  await request('/vcon/files-engine/_status',{status:401});
  const status=await request('/vcon/files-engine/_status',{authenticated:true});
  const fm=await status.json();check(fm.ok===true&&fm.role==='owner'&&fm.readOnly===false,'File Manager status mismatch');
  const api='/vcon/files-engine/api/v1/';
  const from='/'+clientId;
  await request(api+'fs'+from+'/marker.txt',{method:'PUT',authenticated:true,raw:'fa02-volume-marker\n'});
  await request(api+'rename',{method:'PUT',authenticated:true,body:{from:from+'/marker.txt',to:from+'/marker-renamed.txt'}});
  await request(api+'pack',{method:'PUT',authenticated:true,body:{from,to:from+'/fixture.zip',names:['marker-renamed.txt']}});
  fs.mkdirSync(path.join(fixtureRoot,'extracted'),{recursive:true});
  await request(api+'extract',{method:'PUT',authenticated:true,body:{from:from+'/fixture.zip',to:from+'/extracted'}});
  await marker();
  await request(api+'fs'+from+'/marker-renamed.txt',{method:'DELETE',authenticated:true});
  check(!fs.existsSync(path.join(fixtureRoot,'marker-renamed.txt')),'Delete not persisted');
  console.log('FA02_AUTH_HTTP_WS_FILE_MANAGER_PASS');
}
async function queued() {
  await redis.connect();
  await sendWs(ids[2],{text});
  const items=await redis.lrange(queue,0,-1);
  check(items.some(x=>{try{return JSON.parse(x).eventId===ids[2];}catch{return false;}}),'ACKed event missing from Redis');
  console.log('FA02_ACKED_REDIS_EVENT_PRESENT');
}
async function restarted() {
  await login();
  await verifyRows(3);
  await marker();
  console.log('FA02_REDIS_RESTART_RECOVERY_PASS');
}
async function recovery() {
  await login();
  await redis.connect();
  await verifyRows(3);
  const date=state.ts.slice(0,10);
  const oldFiles=fs.readdirSync(fixtureRoot).filter(f=>f.startsWith(date)&&/\.csv(?:\.gz)?$/.test(f));
  check(oldFiles.length>0,'No fixture partitions');
  const records=oldFiles.flatMap(f=>{const data=fs.readFileSync(path.join(fixtureRoot,f));return parse(f.endsWith('.gz')?zlib.gunzipSync(data):data,{columns:true,bom:true,skip_empty_lines:true});});
  assert.deepEqual(records.map(r=>r.eventId).sort(),ids.slice(0,3).sort());
  const parser=new Parser({fields:['clientId','eventId','timestamp','payload']});
  const rawName=date+'-part91.csv',gzName=date+'-part92.csv.gz',badName=date+'-part93.csv.gz';
  for(const f of [rawName,gzName,badName]) check(!fs.existsSync(path.join(fixtureRoot,f)),'Fixture partition collision');
  fs.writeFileSync(path.join(fixtureRoot,rawName),parser.parse(records.filter(r=>r.eventId===ids[0]))+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(fixtureRoot,gzName),zlib.gzipSync(parser.parse(records.filter(r=>r.eventId!==ids[0]))+'\n'),{flag:'wx'});
  for(const f of oldFiles) fs.unlinkSync(path.join(fixtureRoot,f));
  fs.writeFileSync(path.join(fixtureRoot,badName),'invalid disposable gzip',{flag:'wx'});
  const pending=[...records.map(r=>JSON.stringify(r)),JSON.stringify({clientId,eventId:ids[3],timestamp:state.ts,payload:JSON.stringify({text})}),'malformed-fixture-json'];
  check(await redis.llen(queue)===0,'Unexpected pre-existing fixture queue');
  await redis.rpush(queue,...pending);
  await request('/internal/flush',{method:'POST',internal:true,body:{waitMs:5000,throwOnLockTimeout:true},status:500});
  assert.deepEqual(await redis.lrange(queue,0,-1),pending,'Corrupt partition discarded queued records');
  fs.unlinkSync(path.join(fixtureRoot,badName));
  const flush=await request('/internal/flush',{method:'POST',internal:true,body:{waitMs:5000,throwOnLockTimeout:true}});
  check((await flush.json()).success===true,'Recovery flush failed');
  check(await redis.llen(queue)===0,'Redis queue not drained after recovery');
  await verifyRows(4,false);
  check(fs.existsSync(path.join(fixtureRoot,rawName))&&fs.existsSync(path.join(fixtureRoot,gzName)),'Rotated/gzip fixture lost');
  console.log('FA02_CSV_GZIP_REPLAY_CORRUPTION_RECOVERY_PASS');
}
async function main() {
  check(process.env.FA02_FIXTURE==='1','Fixture guard missing');
  if(stage!=='setup') {state=JSON.parse(fs.readFileSync(stateFile,'utf8'));check(typeof state.token==='string'&&typeof state.ts==='string','Invalid fixture state');}
  if(stage==='setup') await setup();
  else if(stage==='queued') await queued();
  else if(stage==='restarted') await restarted();
  else if(stage==='recovery') await recovery();
  else if(stage==='verify') {await login();await request('/api/clients',{authenticated:true});await verifyRows(4,false);await marker();console.log('FA02_PERSISTED_FIXTURE_VERIFIED');}
  else throw new Error('Invalid fixture stage');
}
main().catch(e=>{console.error('FA02_PROBE_FAILED '+(e?.message||'unknown'));process.exitCode=1;}).finally(()=>redis.disconnect());
