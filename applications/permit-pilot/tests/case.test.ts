import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCaseAnalysis,resolveCasePassages,casePassages,type CaseDocument} from '../src/case-analysis.js';
import {caseReport,type PublicCase} from '../src/case-report.js';
const id='modification-final-decision';
const docs:CaseDocument[]=[{id,url:'https://www.woodburn-or.gov/decision',pages:[{number:1,text:'Partial Approval. Project at 1219 and 1233 W Lincoln Street.',textTruncated:false}]}];
const evidence=[{documentId:id,page:1,quote:'Partial Approval.'}];
const result={overview:{summary:'A real case',evidence},timeline:[{date:'2025-12-11',kind:'decision' as const,title:'Decision',detail:'Partial approval',evidence}],tasks:[{title:'Verify evidence',action:'Check the records',timing:'Historical',basis:'modification_decision' as const,evidence}],changes:[{topic:'Access',requested:'Change',decided:'Partial approval',evidence}],questions:[]};
test('case claims must cite known pages and exact nonempty text',()=>{
 assert.deepEqual(validateCaseAnalysis(result,docs),result);
 for(const e of [{documentId:id,page:2,quote:'Partial Approval.'},{documentId:'invented',page:1,quote:'Partial Approval.'},{documentId:id,page:1,quote:'Full Approval.'},{documentId:id,page:1,quote:'  '}]) {
  assert.throws(()=>validateCaseAnalysis({...result,overview:{summary:'test',evidence:[e]}},docs),/evidence/);
 }
});
test('staff recommendations cannot be used alone as final decision evidence',()=>{
 const renamed=JSON.parse(JSON.stringify(result).replaceAll(id,'staff-report'));
 assert.throws(()=>validateCaseAnalysis(renamed,[{...docs[0]!,id:'staff-report'}]),/final-decision/);
});
test('case report escapes content and keeps fulfillment and drawing coverage explicit',()=>{
 const c:PublicCase={name:'<script>alert(1)</script>',location:'Woodburn',caseIds:['MOC 25-02'],projectPage:'https://www.woodburn-or.gov/',files:[{id,url:docs[0]!.url,pages:5,bytes:100,sha256:'test',analyze:true}]};
 const html=caseReport(c,result,docs,{model:'test',usage:null,at:'2026-09-29'});
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(html.includes('Fulfillment unknown'));assert.ok(html.includes('have not been analyzed'));
 assert.ok(html.includes('#page=1'));
});

test('passage IDs resolve to original quotations and invented IDs fail',()=>{
 const passage=casePassages(docs)[0]!;
 const model=JSON.parse(JSON.stringify(result));
 for(const item of [model.overview,...model.timeline,...model.tasks,...model.changes])item.evidence=[{passageId:passage.passageId}];
 const resolved=resolveCasePassages(model,docs);
 assert.equal(resolved.overview.evidence[0]?.quote,docs[0]?.pages[0]?.text);
 model.overview.evidence=[{passageId:'invented'}];
 assert.throws(()=>resolveCasePassages(model,docs),/Unknown source/);
});
