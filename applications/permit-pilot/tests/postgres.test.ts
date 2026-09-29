import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresStore, validateTask } from '../src/postgres-store.js';
import type { Job } from '../src/web-state.js';
const url = process.env.PERMITPILOT_TEST_DATABASE_URL;
const job = (id: string): Job => ({ id, portal: 'pinecrest', portalLabel: 'Pinecrest', permit: 'BL2024-1706', email: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, status: 'queued', dir: '/old/' + id + '-pinecrest-live', error: null });

test('task input rejects bad dates, oversized fields and unknown states', () => {
  const good = { title: 'Confirm structural response', owner: 'Coordinator', dueDate: '2026-10-05', status: 'open', notes: 'Read the cited source first.' };
  assert.equal(validateTask(good).dueDate, '2026-10-05');
  for (const update of [{dueDate:'2026-02-30'},{status:'approved'},{title:''},{notes:'x'.repeat(4001)}]) assert.throws(() => validateTask({...good,...update}));
});

test('PostgreSQL persists queue, enforces global admission and detects concurrent task edits', { skip: !url }, async () => {
  // This test requires an explicitly designated disposable database, never DATABASE_URL.
  const clean = new pg.Client({ connectionString: url }); await clean.connect();
  await clean.query('DROP TABLE IF EXISTS pp_task_audit, pp_tasks, pp_jobs CASCADE'); await clean.end();
  const first = new PostgresStore(url!); await first.open();
  try {
    const competitor = new PostgresStore(url!); await assert.rejects(competitor.open(), /Another PermitPilot runner/);
    const results = await Promise.allSettled([first.enqueue(job('aaaaaaaaaaaa'), 'one', 2, 5, 8), first.enqueue(job('bbbbbbbbbbbb'), 'two', 2, 5, 8), first.enqueue(job('cccccccccccc'), 'three', 2, 5, 8)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    const all = await first.restore('/data'); assert.equal(all.size, 2);
    const captured = [...all.values()][0]!; captured.status = 'running'; await first.save(captured);
    const secondJob = [...all.values()][1]!;
    const input = validateTask({ title: '<script>never execute</script>', owner: 'A', dueDate: '2026-10-05', status: 'open', notes: "O'Brien; keep the exact source text" });
    const t = await first.createTask(captured.id, input);
    const edit = await first.updateTask(t.id, {...input,status:'in_progress'}, 1); assert.equal(edit.version,2);
    await assert.rejects(first.updateTask(t.id,{...input,status:'done'},1), /changed since/);
    assert.equal((await first.audit(t.id)).length,2);
    await first.close();
    const restarted = new PostgresStore(url!); await restarted.open();
    try {
      const restored = await restarted.restore('/new-data');
      assert.equal(restored.get(captured.id)!.status,'failed');
      assert.equal(restored.get(secondJob.id)!.status,'queued');
      assert.ok(restored.get(secondJob.id)!.dir.startsWith('/new-data/'));
      assert.equal((await restarted.listTasks(captured.id))[0]!.status,'in_progress');
      assert.equal((await restarted.listTasks(captured.id))[0]!.dueDate,'2026-10-05');
      await assert.rejects(restarted.enqueue(job('dddddddddddd'),'four',2,5,8),/daily/);
    } finally { await restarted.close(); }
  } catch (error) { await first.close().catch(()=>undefined); throw error; }
});

import { mkdtemp, mkdir, copyFile, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { Script } from 'node:vm';
test('private workspace HTTP API requires a key and returns conflicts for stale edits', { skip: !url, timeout: 20_000 }, async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));const dir=await mkdtemp(join(tmpdir(),'permit-pg-http-'));let child:ChildProcess|undefined;
  try {
    await mkdir(join(dir,'src'));await cp(join(root,'cases'),join(dir,'cases'),{recursive:true});
    for(const f of ['server.ts','web-state.ts','portal-cases.ts','admin-ui.ts','postgres-store.ts'])await copyFile(join(root,'src',f),join(dir,'src',f));
    await symlink(join(root,'node_modules'),join(dir,'node_modules'));await writeFile(join(dir,'package.json'),'{"type":"module"}');
    const key='test-operator-key-32-characters-long';
    const base=await new Promise<string>((resolve,reject)=>{
      child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:dir,env:{...process.env,PORT:'0',DATABASE_URL:url!,PERMITPILOT_ADMIN_KEY:key,PERMITPILOT_LIVE:'0',PERMITPILOT_DATA_DIR:join(dir,'data')},stdio:['ignore','pipe','pipe']});
      let out='';child.stdout!.on('data',b=>{out+=b;const m=/http:\/\/localhost:(\d+)/.exec(out);if(m)resolve('http://127.0.0.1:'+m[1]);});child.stderr!.on('data',b=>{out+=b;});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(out));});
    });
    assert.equal((await fetch(base+'/api/admin/jobs')).status,401);
    assert.equal((await fetch(base+'/api/admin/jobs',{headers:{authorization:'Bearer wrong'}})).status,401);
    const auth={authorization:'Bearer '+key,'content-type':'application/json'};
    const jobs=await fetch(base+'/api/admin/jobs',{headers:auth}).then(r=>r.json()) as {id:string}[];assert.equal(jobs.length,2);
    const html=await fetch(base+'/workspace').then(r=>r.text());assert.ok(!html.includes(key));for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(m[1]!);
    const data={title:'Check the source response',owner:'Coordinator',dueDate:null,status:'open',notes:'A manual follow-up, not a portal finding.'};
    const created=await fetch(base+'/api/admin/jobs/'+jobs[0]!.id+'/tasks',{method:'POST',headers:auth,body:JSON.stringify(data)});assert.equal(created.status,201);const task=await created.json() as {id:string;version:number};
    const patch=()=>fetch(base+'/api/admin/tasks/'+task.id,{method:'PATCH',headers:auth,body:JSON.stringify({...data,status:'done',version:task.version})});
    assert.equal((await patch()).status,200);assert.equal((await patch()).status,409);
    assert.equal((await fetch(base+'/api/admin/tasks/'+task.id+'/audit')).status,401);
    const audit=await fetch(base+'/api/admin/tasks/'+task.id+'/audit',{headers:auth}).then(r=>r.json()) as unknown[];assert.equal(audit.length,2);
  } finally { if(child&&child.exitCode===null){const end=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await end;}await rm(dir,{recursive:true,force:true}); }
});
