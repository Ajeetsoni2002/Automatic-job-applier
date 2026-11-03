import fs from 'node:fs';
import { ApplicationModel, SavedAnswerModel, allSkills, connectDb, disconnectDb, loadProfile, loadQaBank } from '@ja/shared';
import { openBrowser } from '../apps/worker/src/apply/browser.js';
import { answersForPage } from '../apps/worker/src/apply/link.js';
import { buildVocabulary } from '../apps/worker/src/tailor/claims.js';
import { walkForm } from '../apps/worker/src/apply/walk.js';
import type { AnswerContext } from '../apps/worker/src/apply/answers.js';
import type { Answer, FormField } from '../apps/worker/src/apply/types.js';

await connectDb();
try {
  const app = await ApplicationModel.findOne({applyUrl:{$regex:'surveys.infosysapps.com'}}).sort({updatedAt:-1}).lean();
  if (!app) throw new Error('No saved Infosys application');
  const profile = loadProfile().data;
  const ctx: AnswerContext = {profile,qaBank:loadQaBank().data,saved:await SavedAnswerModel.find().lean(),job:{title:'Infosys registration',company:'Infosys',location:'India',description:''},files:{},vocab:buildVocabulary(allSkills(profile))};
  let stored = app.answers as (Answer & {step?:number})[];
  let previous: FormField[] = [];
  let round=0;
  fs.mkdirSync('output/diagnostics',{recursive:true});
  const browser = await openBrowser({profile:'links',headless:false});
  try {
    const page = await browser.newPage();
    await page.goto(app.applyUrl,{waitUntil:'domcontentloaded',timeout:60000});
    const result = await walkForm(browser,page,{
      answersFor: async(fields,step)=>{
        round++;
        const shape=(f:FormField)=>JSON.stringify([f.key,f.label,f.kind,f.required,f.options]);
        const delta=fields.filter(f=>!previous.some(p=>shape(p)===shape(f)));
        console.log(JSON.stringify({round,step,fields:fields.length,changed:delta.map(f=>({key:f.key,label:f.label,kind:f.kind,required:f.required,optionsCount:f.options?.length,optionStart:f.options?.slice(0,2)})),removed:previous.filter(f=>!fields.some(p=>p.key===f.key)).map(f=>({key:f.key,label:f.label}))}));
        previous=fields;
        const out=await answersForPage(fields,step,stored,ctx,async()=>({answers:[]}) as never);
        stored=[...stored.filter(a=>(a.step??0)!==step),...out.answers];
        console.log(JSON.stringify({needsInput:out.answers.filter(a=>a.needsInput).map(a=>a.label)}));
        return out.answers;
      },
      shouldSubmit:()=>false,dryRun:true,headless:false,loginWaitMs:0,captchaWaitMs:0,maxSteps:3,
      shoot:async(p,label)=>{await p.screenshot({path:`output/diagnostics/infosys-${label}.png`,fullPage:true}); if(label.startsWith('page-3'))fs.writeFileSync('output/diagnostics/infosys-education.html',await p.content());},
    });
    console.log(JSON.stringify({result,url:page.url()}));
    await page.screenshot({path:'output/diagnostics/infosys-last.png',fullPage:true});
  } finally {await browser.close();}
} finally {await disconnectDb();}
