'use strict';
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { runBackup } = require('./lib');

(async () => {
  const need = ['FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = need.filter(k => !process.env[k]);
  if(missing.length){
    console.error('Missing GitHub secret(s): ' + missing.join(', ') + '. Add them under Settings > Secrets and variables > Actions (see BACKUP-SETUP.md).');
    process.exit(1);
  }
  let account;
  try{ account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
  catch(e){ console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the entire downloaded key file as the secret.'); process.exit(1); }
  initializeApp({ credential: cert(account) });
  const db = getFirestore();
  const force = String(process.env.FORCE || '').toLowerCase() === 'true';
  await runBackup({ db, fetch, env: process.env, now: Date.now(), force, log: m => console.log(m) });
})().catch(err => {
  if(!(err && err.reported)){
    // Typical causes: wrong/expired Firebase key, wrong project, Firestore API not enabled.
    console.error('Backup could not start: ' + String((err && err.message) || 'unexpected error').replace(/\s+/g, ' ').slice(0, 220));
  }
  process.exit(1);
});
