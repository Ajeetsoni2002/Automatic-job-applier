import { ApplicationModel, connectDb, disconnectDb } from '@ja/shared';
import { runLinkApplication } from '../apps/worker/src/apply/link.js';

await connectDb();
try {
  const app = await ApplicationModel.findById('6ae85bf5eb244cee3ed9afbd').lean();
  if (!app || !app.applyUrl.startsWith('https://surveys.infosysapps.com/')) throw new Error('Expected Infosys application missing');
  const status = await runLinkApplication(String(app._id), { submit: false });
  const latest = await ApplicationModel.findById(app._id).lean();
  console.log(JSON.stringify({status,error:latest?.error,missing:latest?.answers.filter(a=>a.needsInput).map(a=>({label:a.label,step:a.step})),screenshots:latest?.screenshots.slice(-2)},null,2));
} finally {await disconnectDb();}
