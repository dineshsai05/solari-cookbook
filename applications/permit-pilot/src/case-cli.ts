import {readFile,writeFile,mkdir,appendFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {config} from 'dotenv';
import {Solari} from '@solarisdk/browser';
import {withPythonSandbox} from './sandbox-python.js';
import {analyzeCase,type CaseDocument} from './case-analysis.js';
import {caseReport,type PublicCase} from './case-report.js';
import {digest} from './sources.js';
const root=fileURLToPath(new URL('../',import.meta.url));
config({path:join(root,'.env'),quiet:true});
try {await main();} catch(error) {
 let message=error instanceof Error?error.message:'Case run failed';
 for(const key of ['SOLARI_API_KEY','AIML_API_KEY']) if(process.env[key]) message=message.split(process.env[key]!).join('[REDACTED]');
 console.error(message.replace(/https?:\/\/[^\s]+/g,'[URL omitted]').slice(0,1200));process.exitCode=1;
}
async function main(){
 for(const key of ['SOLARI_API_KEY','AIML_API_KEY','AIML_MODEL']) if(!process.env[key]?.trim()) throw new Error(`${key} is missing`);
 const {values}=parseArgs({options:{resume:{type:'string'}},strict:true});
 const c:PublicCase=JSON.parse(await readFile(join(root,'cases/farmdale.json'),'utf8'));
 const out=join(root,'artifacts',`${Date.now()}-farmdale-live`);await mkdir(out,{recursive:true});
 const event=async(name:string,detail:unknown={})=>{console.log(name);await appendFile(join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),name,detail})+'\n');};
 const manifest={mode:'live-public-case',status:'running',case:c.name,startedAt:new Date().toISOString(),provider:'aiml',model:process.env.AIML_MODEL,files:c.files,sourceCapturedAt:new Date().toISOString(),resumedFrom:values.resume?resolve(values.resume):null};
 const save=()=>writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));await save();
 try {
  let documents:CaseDocument[];
  if(values.resume){
   const previous=resolve(values.resume);
   const prior=JSON.parse(await readFile(join(previous,'manifest.json'),'utf8'));
   if(prior.mode!=='live-public-case'||prior.case!==c.name||JSON.stringify(prior.files)!==JSON.stringify(c.files)) throw new Error('Resume requires matching Farmdale source manifest');
   manifest.sourceCapturedAt=prior.sourceCapturedAt||prior.startedAt;await save();
   documents=JSON.parse(await readFile(join(previous,'documents.json'),'utf8'));
   if(documents.length!==c.files.filter(f=>f.analyze).length) throw new Error('Resume document count mismatch');
   for(const f of c.files.filter(f=>f.analyze)) if(documents.find(d=>d.id===f.id)?.pages.length!==f.pages) throw new Error('Resume page coverage mismatch');
   for(const file of ['documents.json','project-page.png','project-page.txt']) await copyFile(join(previous,file),join(out,file));
   await event('extraction_reused',{from:previous,originalCaptureAt:prior.startedAt});
  }else{
  const client=new Solari({apiKey:process.env.SOLARI_API_KEY!});let browser:Awaited<ReturnType<Solari['launch']>>|undefined;
  try {
   browser=await client.launch({recording:true});await event('browser_created',{id:browser.id});
   const page=await browser.newPage();const response=await page.goto(c.projectPage,{waitUntil:'domcontentloaded',timeout:45000});
   if(!response?.ok()||new URL(page.url()).hostname!=='www.woodburn-or.gov') throw new Error('Official project page unavailable');
   const text=await page.locator('body').innerText();if(!text.includes('DR 25-02')||!text.includes('45-unit')) throw new Error('Project source changed');
   await writeFile(join(out,'project-page.txt'),text);await page.screenshot({path:join(out,'project-page.png'),fullPage:true});
   await event('project_page_captured',{url:page.url(),sha256:digest(text)});
  } finally {try{if(browser)await browser.close();}finally{await client.close();}}
  documents=await withPythonSandbox(process.env.SOLARI_API_KEY!,event,async({sandbox,run,python,work})=>{
   await sandbox.files.write(`${work}/case.json`,JSON.stringify(c));await sandbox.files.write(`${work}/extract.py`,await readFile(join(root,'python/case_extract.py')));
   await run(python,[`${work}/extract.py`,work]);
   return JSON.parse(Buffer.from(await sandbox.files.read(`${work}/documents.json`)).toString()) as CaseDocument[];
  });
  for(const f of c.files.filter(f=>f.analyze)) if(documents.find(d=>d.id===f.id)?.pages.length!==f.pages) throw new Error('Case extraction coverage mismatch');
  await writeFile(join(out,'documents.json'),JSON.stringify(documents,null,2));await event('case_documents_extracted',{documents:documents.length,pages:documents.reduce((n,d)=>n+d.pages.length,0)});
  }
  const interpreted=await analyzeCase(documents,process.env.AIML_API_KEY!,process.env.AIML_MODEL!,response=>writeFile(join(out,'model-response.json'),JSON.stringify(response,null,2)));
  await writeFile(join(out,'analysis.json'),JSON.stringify(interpreted,null,2));
  await writeFile(join(out,'report.html'),caseReport(c,interpreted.analysis,documents,{model:interpreted.model,usage:interpreted.usage,at:manifest.sourceCapturedAt}));
  manifest.status='completed';await save();await event('case_report_generated');console.log(`Report: ${join(out,'report.html')}`);
 }catch(error){manifest.status='failed';await save();await event('failed',{errorType:error instanceof Error?error.name:'unknown'});throw error;}
}
