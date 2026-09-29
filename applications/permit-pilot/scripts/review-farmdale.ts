import {readFile,writeFile} from 'node:fs/promises';
import {caseReport} from '../src/case-report.js';
import {casePassages,validateCaseAnalysis} from '../src/case-analysis.js';
// Usage: node --import tsx scripts/review-farmdale.ts artifacts/<timestamp>-farmdale-live
// Applies the documented reviewer corrections to one Farmdale run. The raw model
// output stays in analysis.json; the corrected version is written separately.
const out=process.argv[2];if(!out)throw new Error('Pass the Farmdale run directory');
const original=JSON.parse(await readFile(`${out}/analysis.json`,'utf8'));const a=structuredClone(original.analysis);
const docs=JSON.parse(await readFile(`${out}/documents.json`,'utf8'));const c=JSON.parse(await readFile('cases/farmdale.json','utf8'));const manifest=JSON.parse(await readFile(`${out}/manifest.json`,'utf8'));
const passages=casePassages(docs);
function refs(id:string,page:number,words:string){const found=passages.filter(p=>p.documentId===id&&p.page===page&&p.quote.includes(words));if(!found.length)throw new Error('Missing reviewed passage: '+words);return found.map(({documentId,page,quote})=>({documentId,page,quote}));}
const staff='staff-report-2025-12-04',decision='modification-final-decision',letter='completeness-letter-2025-10-29';
a.overview.summary='Farmdale is a proposed 45-unit apartment redevelopment in Woodburn. This review follows its modification-of-conditions case: the applicant sought to remove a pedestrian corridor requirement and restrict vehicle access between two parcels. The December 11, 2025 decision allowed restricted vehicle access, denied removal of the corridor requirement, and allowed its relocation. Other original conditions remained unchanged. This is land-use review history, not confirmation of a building permit or completed construction.';
a.overview.evidence=[...refs(staff,2,'45-unit'),...refs(decision,3,'ultimately voted')];
a.timeline.find((t:any)=>t.kind==='recommendation').title='Staff report dated';
a.timeline.find((t:any)=>t.kind==='decision').detail='The December 11 hearing included testimony from the applicant and consultants, with no public testimony recorded. The Commission approved the access modification, denied the variance, and adopted a condition relocating the corridor. Other original conditions remained unchanged.';
a.timeline.push({date:'2025-12-01',kind:'historical_deadline',title:'Historical sign-posting deadline',detail:'The October letter stated December 1 as the notice-posting deadline for the planned December 11 hearing. Whether proof was submitted has not been established from this packet.',evidence:refs(letter,1,'December 1, 2025')});
for(const t of a.tasks){
 if(t.title.includes('Fence')||t.title.includes('Sign Permit'))t.timing='No explicit deadline stated in the cited condition; confirm timing.';
 if(t.title.includes('Mid-block')){
 t.action='Verify the relocated corridor condition and its implementation. Staff’s adopted recommendation distinguishes an easement at least 8 feet wide from a paved path at least 6 feet wide. It calls for an affirmative covenant at partition recording and construction of the path during future redevelopment of Parcel 2.';
 t.timing='Covenant at partition recording; path at future redevelopment of Parcel 2';
 t.evidence=[...refs(decision,3,'ultimately voted'),...refs(staff,9,'Concurrent with recordation'),...refs(staff,9,'6 feet wide')];
 }
 if(t.title.includes('Cross-Access')){t.action='Verify the modified private-access easement restricting vehicle access to emergency responders and maintenance staff. Confirm dimensions against the final annotated conditions and record the instrument via the partition plat or as directed by the County Surveyor.';t.timing='Via partition plat or County Surveyor direction';t.evidence=[...refs(decision,3,'ultimately voted'),...refs(staff,9,'20 feet wide'),...refs(staff,9,'Surveyor')];}
 if(t.title.includes('Fire Protection')){t.action='Confirm whether additional on-site hydrants are required. If required, the recorded condition calls for a public looped water line serving those hydrants, completed and inspected before building permit issuance. The requirement is conditional, not proof that this work remains outstanding.';t.evidence=[...refs(staff,7,'If the development'),...refs(staff,7,'hydrants on-site')];}
 if(t.title.includes('Tree Removal'))t.evidence=[...refs(staff,8,'Tree removal fee'),...refs(staff,8,'$600')];
}
a.questions=[{title:'Confirm the address on the sign-posting certificate',detail:'The decision identifies 1219 and 1233 W Lincoln Street, while the sign-posting certificate prints 1223. Confirm whether 1223 is a clerical issue or a valid related address. The use of both 1219 and 1233 elsewhere is not itself a conflict.',evidence:[...refs(decision,1,'Project location'),...refs(letter,4,'1223')]}];
a.tasks.push({title:'Verify historical public-notice proof',action:'The October letter requested notice posting and proof consisting of photographs and a completed certificate. Confirm whether that evidence was supplied; the packet does not establish fulfillment.',timing:'Historical deadline: December 1, 2025',basis:'historical_instruction',evidence:[...refs(letter,1,'December 1, 2025'),...refs(letter,3,'Proof of Posting')]});
const notes=['Corrected the distinction between an 8-foot access easement and a 6-foot paved path, and separated covenant timing from future path construction.','Preserved the conditional wording of the fire-protection requirement and removed inferred deadlines for fences and signs.','Added the historical notice deadline and candidate 1223 address discrepancy; replaced an unsupported claim of address consistency.','Described the December 4 date as the staff report date, and preserved the distinction between no public testimony and no public opposition.'];
validateCaseAnalysis(a,docs);
await writeFile(`${out}/reviewed-analysis.json`,JSON.stringify({analysis:a,reviewNotes:notes,original:'analysis.json'},null,2));
await writeFile(`${out}/report.html`,caseReport(c,a,docs,{model:original.model,usage:original.usage,at:manifest.sourceCapturedAt,reviewNotes:notes}));
console.log('Reviewed report regenerated; raw AI result preserved.');
