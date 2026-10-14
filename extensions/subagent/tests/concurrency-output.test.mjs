import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createJiti } from 'jiti';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const jiti = createJiti(import.meta.url);
const { mapWithConcurrencyLimit: map } = await jiti.import(new URL('../concurrency.ts', import.meta.url).pathname);
const { getFinalOutput } = await jiti.import(new URL('../message-output.ts', import.meta.url).pathname);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('文本合并过滤非法块并保留向前查找语义', () => {
 const a = (content) => ({role:'assistant',content});
 assert.equal(getFinalOutput([a([{type:'text',text:'甲'},{type:'thinking',thinking:'秘密'},{type:'text',text:9},{type:'toolCall',name:'x'},null,{type:'text',text:'乙'}]),a([{type:'toolCall'}])]), '甲乙');
 assert.equal(getFinalOutput([a([{type:'text',text:''}])]), '');
});

for (const error of [undefined, null, false, 0, new Error('首错')]) test(`首错原样保留并等待收尾：${String(error)}`, async () => {
 const started = []; const ended = [];
 const p = map([0,1,2,3,4,5,6,7],4,async (item,index,signal) => {
  started.push(index);
  if (index === 0) { await delay(10); throw error; }
  await new Promise((r) => signal.addEventListener('abort',r,{once:true}));
  await delay(30); ended.push(index); throw new Error('次错');
 });
 await p.then(() => assert.fail('必须失败'), (e) => assert.equal(e,error));
 assert.deepEqual(started,[0,1,2,3]); assert.deepEqual(ended.sort(),[1,2,3]);
});

test('外部预取消不启动，运行取消等待收尾且移除监听', async () => {
 for (const pre of [true,false]) {
  const c = new AbortController(); let started=0; let ended=0;
  if(pre)c.abort();
  const p=map([1,2,3],2,async (_,__,signal)=>{started++; await new Promise((r)=>signal.addEventListener('abort',r,{once:true})); await delay(20); ended++;},c.signal);
  const result=p.then(()=>assert.fail(),e=>assert.match(e.message,/aborted/));
  if(!pre)c.abort(); await result;
  assert.equal(started,pre?0:2); assert.equal(ended,started);
  assert.equal(getEventListeners(c.signal,'abort').length,0);
 }
});

test('普通失败结果仍执行全部独立任务', async () => {
 assert.deepEqual(await map([1,2,3],2,async()=>({exitCode:1})),[{exitCode:1},{exitCode:1},{exitCode:1}]);
});

fs.mkdirSync(resolve('.temp'),{recursive:true});
const dir=fs.mkdtempSync(join(resolve('.temp'),'subagent-concurrency-'));
fs.mkdirSync(join(dir,'.pi','agents'),{recursive:true});
fs.writeFileSync(join(dir,'.pi','agents','controlled.md'),'---\nname: controlled\ndescription: 测试\n---\n测试');
const tools=[];
(await jiti.import(new URL('../index.ts',import.meta.url).pathname)).default({registerTool:t=>tools.push(t)});
const tool=tools[0];
const base={agentScope:'project',confirmProjectAgents:false};
const ctx={cwd:dir,hasUI:false};
async function withScript(code,fn) {
 const script=join(dir,`child-${Math.random()}.cjs`);fs.writeFileSync(script,code);
 const prev=process.argv[1];process.argv[1]=script;
 try{return await fn();}finally{process.argv[1]=prev;}
}

test('真实工具合并最终、详情及链输入，保留输出截断',async()=>{
 await withScript(`const t=process.argv.at(-1);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:t.includes('second')?t:'甲'},{type:'thinking',thinking:'隐藏'},{type:'text',text:'乙'}],usage:{input:2},stopReason:'stop'}}));`,async()=>{
  const r=await tool.execute('id',{...base,chain:[{agent:'controlled',task:'first'},{agent:'controlled',task:'second {previous}'}]},undefined,undefined,ctx);
  assert.match(r.content[0].text,/second 甲乙乙/); assert.equal(r.details.results[0].messages[0].content[0].text,'甲乙');
 });
 await withScript(`console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'a'.repeat(150)},{type:'text',text:'b'.repeat(150)}],stopReason:'stop'}}));`,async()=>{
  const r=await tool.execute('id',{...base,agent:'controlled',task:'first',maxOutputChars:200},undefined,undefined,ctx);
  assert.equal(r.content[0].text.length,200); assert.equal(r.details.results[0].messages[0].content[0].text.length,200);
 });
});

for(const reason of ['error','aborted','stop'])test(`真实普通失败总体标记，模型停止原因=${reason}`,async()=>{
 await withScript(`console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'完成'}],stopReason:${JSON.stringify(reason)}}}));process.exitCode=${reason==='stop'?1:0};`,async()=>{
  const r=await tool.execute('id',{...base,tasks:Array.from({length:8},()=>({agent:'controlled',task:'x'}))},undefined,undefined,ctx);
  assert.equal(r.isError,true);assert.equal(r.details.results.length,8);assert.match(r.content[0].text,/0\/8 succeeded/);
 });
});

test('真实启动失败取消同批进程、停止队列、保留用量且返回后无更新',async()=>{
 const original=fs.promises.mkdtemp; let calls=0;
 const liveDir=fs.mkdtempSync(join(dir,'live-'));
 const missing=join(liveDir,'private-missing-cwd');
 const script=`const fs=require('node:fs');const path=require('node:path');const id=process.argv.at(-1).split(' ').at(-1);fs.writeFileSync(path.join(${JSON.stringify(liveDir)},id),String(process.pid));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'已启动'}],usage:{input:7},stopReason:'stop'}}));process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),80)});setInterval(()=>{},1000);`;
 // 延迟第四个提示文件准备，让前三个真实进程进入受控运行状态。
 fs.promises.mkdtemp=async(...args)=>{
  if(++calls===4){for(let i=0;i<500 && fs.readdirSync(liveDir).length<3;i++)await delay(10);assert.equal(fs.readdirSync(liveDir).length,3);await delay(50);}
  return original(...args);
 };
 let updates=0;
 try{await withScript(script,async()=>{
  const r=await tool.execute('id',{...base,tasks:Array.from({length:8},(_,i)=>({agent:'controlled',task:String(i+1),cwd:i===3?missing:dir}))},undefined,()=>updates++,ctx);
  assert.equal(r.isError,true);assert.equal(calls,4);assert.equal(r.details.results.length,8);
  assert.deepEqual(r.details.results.slice(0,3).map(x=>x.stopReason),['aborted','aborted','aborted']);
  assert.equal(r.details.results.slice(0,3).reduce((n,x)=>n+x.usage.input,0),21);
  assert.match(r.details.results[4].errorMessage,/未启动/);
  assert.doesNotMatch(JSON.stringify(r),/private-missing-cwd/);
  for(const file of fs.readdirSync(liveDir))assert.throws(()=>process.kill(Number(fs.readFileSync(join(liveDir,file),'utf8')),0));
  const count=updates;await delay(150);assert.equal(updates,count);
 });}finally{fs.promises.mkdtemp=original;}
});

test('真实工具运行中外部取消等待四进程退出，队列不启动且保留用量',async()=>{
 const live=fs.mkdtempSync(join(dir,'abort-')); const c=new AbortController(); let updates=0;
 await withScript(`const fs=require('node:fs');const path=require('node:path');const id=process.argv.at(-1).split(' ').at(-1);fs.writeFileSync(path.join(${JSON.stringify(live)},id),String(process.pid));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'运行'}],usage:{input:3},stopReason:'stop'}}));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));setInterval(()=>{},1000);`,async()=>{
  const pending=tool.execute('id',{...base,tasks:Array.from({length:8},(_,i)=>({agent:'controlled',task:String(i+1)}))},c.signal,()=>updates++,ctx);
  const outcome=pending.then(()=>assert.fail(),e=>e);
  for(let i=0;i<500 && updates<4;i++)await delay(10);
  assert.equal(fs.readdirSync(live).length,4); c.abort();
  const e=await outcome; assert.match(e.message,/aborted/);
  assert.equal(e.usage.input,12);assert.equal(e.details.results.length,8);
  assert.ok(e.details.results.every(r=>r.stopReason==='aborted'));
  for(const file of fs.readdirSync(live))assert.throws(()=>process.kill(Number(fs.readFileSync(join(live,file),'utf8')),0));
  const count=updates;await delay(120);assert.equal(updates,count);
  assert.equal(getEventListeners(c.signal,'abort').length,0);
 });
});

for (const mode of ['once', 'repeat', 'close', 'progress']) test(`独立宿主真实回调异常安全收尾：${mode}`, () => {
 const live=fs.mkdtempSync(join(dir,`callback-${mode}-`));
 const backend=join(live,'backend.cjs');
 const host=join(live,'host.mjs');
 fs.writeFileSync(backend,`
 const fs=require('node:fs'),path=require('node:path');
 const live=${JSON.stringify(live)},mode=${JSON.stringify(mode)};
 const id=process.argv.at(-1).split(' ').at(-1);
 fs.writeFileSync(path.join(live,'pid-'+id),String(process.pid));
 process.on('exit',()=>fs.writeFileSync(path.join(live,'closed-'+id),'closed'));
 process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));
 const message=JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'真实消息'}],usage:{input:7},stopReason:'stop'}});
 process.stdout.write(message+(mode==='close'?'':'\\n'));
 if(mode==='close'||mode==='progress') {
  const timer=setInterval(()=>{if(fs.readdirSync(live).filter(x=>x.startsWith('pid-')).length===4){clearInterval(timer);setTimeout(()=>process.exit(0),100);}},10);
 } else setInterval(()=>{},1000);
 `);
 fs.writeFileSync(host,`
 import assert from 'node:assert/strict';
 import fs from 'node:fs';
 import {join} from 'node:path';
 import {createJiti} from ${JSON.stringify(import.meta.resolve('jiti'))};
 const jiti=createJiti(import.meta.url),tools=[];
 (await jiti.import(${JSON.stringify(new URL('../index.ts',import.meta.url).pathname)})).default({registerTool:t=>tools.push(t)});
 const live=${JSON.stringify(live)},mode=${JSON.stringify(mode)},prompts=[];
 const original=fs.promises.mkdtemp;
 fs.promises.mkdtemp=async(...args)=>{const p=await original(...args);prompts.push(p);return p;};
 process.argv[1]=${JSON.stringify(backend)};
 let updates=0,throws=0;
 const result=await tools[0].execute('id',{agentScope:'project',confirmProjectAgents:false,tasks:Array.from({length:8},(_,i)=>({agent:'controlled',task:String(i+1)}))},undefined,(partial)=>{
  updates++;
  const results=partial.details.results;
  const usage=results.reduce((n,r)=>n+r.usage.input,0);
  const ready=mode==='close'?usage>0:mode==='progress'?usage===28&&results.some(r=>r.exitCode===0):usage===28;
  if(ready&&(mode==='repeat'||throws===0)){throws++;throw mode==='once'?false:mode==='close'?null:new Error('回调首错');}
 },{cwd:${JSON.stringify(dir)},hasUI:false});
 assert.equal(result.isError,true);
 assert.equal(prompts.length,4);
 assert.ok(prompts.every(p=>!fs.existsSync(p)));
 assert.ok(throws>=1);
 if(mode==='repeat')assert.ok(throws>=2);
 const pids=fs.readdirSync(live).filter(x=>x.startsWith('pid-'));
 assert.equal(pids.length,4);
 for(const file of pids){assert.throws(()=>process.kill(Number(fs.readFileSync(join(live,file),'utf8')),0));assert.ok(fs.existsSync(join(live,file.replace('pid-','closed-'))));}
 assert.ok(result.details.results.slice(4).every(r=>/未启动/.test(r.errorMessage)));
 const usage=result.details.results.reduce((n,r)=>n+r.usage.input,0);
 assert.ok(usage>=7);
 if(mode!=='close')assert.equal(usage,28);
 const count=updates;
 await new Promise(r=>setTimeout(r,150));assert.equal(updates,count);
 console.log(JSON.stringify({mode,updates,throws,usage,closed:pids.length}));
 `);
 const outcome=spawnSync(process.execPath,[host],{encoding:'utf8',timeout:20000});
 assert.equal(outcome.error,undefined);
 assert.equal(outcome.status,0,`${outcome.stdout}\n${outcome.stderr}`);
 const audit=JSON.parse(outcome.stdout.trim());
 assert.equal(audit.closed,4);
});

test('真实工具外部预取消不派发任务',async()=>{
 const c=new AbortController();c.abort();let updates=0;
 await assert.rejects(tool.execute('id',{...base,tasks:[{agent:'controlled',task:'x'}]},c.signal,()=>updates++,ctx),e=>{
  assert.match(e.message,/aborted/);assert.match(e.details.results[0].errorMessage,/未启动/);return true;
 });assert.equal(updates,0);
});
