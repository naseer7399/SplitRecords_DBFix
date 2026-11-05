'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { runBackup, decide, composeV2, FILE_PREFIX, FOLDER_NAME, SLACK } = require('./lib');
const clone = o => JSON.parse(JSON.stringify(o));
const HOUR = 3600e3, DAY = 24 * HOUR;

/* ---------- fake Firestore (admin-SDK shaped) ---------- */
class MockDb {
  constructor(){ this.store = new Map(); this.reads = 0; }
  doc(path){
    const me = this;
    return {
      get: async () => { me.reads++; const v = me.store.get(path); return { exists: v !== undefined, data: () => (v === undefined ? undefined : clone(v)) }; },
      set: async (data, opts) => { const cur = me.store.get(path) || {}; me.store.set(path, opts && opts.merge ? Object.assign({}, cur, clone(data)) : clone(data)); }
    };
  }
  collection(path){
    const me = this, depth = path.split('/').length + 1;
    return { get: async () => {
      const docs = [...me.store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === depth).map(k => ({ id: k.split('/').pop(), data: () => clone(me.store.get(k)) }));
      me.reads += Math.max(1, docs.length);
      return { docs };
    } };
  }
}
function seedCloud(db, n = 50){
  const put = (p, v) => db.store.set(p, v);
  put('ikhlas_school/settings', { schemaVersion: 2, school: { name: 'Ikhlas', address: 'X', minAttendance: 75 }, alertSettings: { feeBilled: true }, deletedStudents: {} });
  put('ikhlas_school/secrets', { mgmtPassword: 'm', feePaymentsPassword: 'f', dataPassword: 'd' });
  put('ikhlas_school/branding', { logo: 'data:image/png;base64,AAAA' });
  put('ikhlas_school/alerts', { log: [{ id: 'A1', title: 't' }] });
  for(let i = 1; i <= n; i++){
    put('ikhlas_school/data/students/' + (1000 + i), { id: String(1000 + i), name: 'SecretName' + i, studentAadhar: '1234 5678 ' + i, class: '9', _o: n - i + 1, _t: 1, _by: 'x' });
    put('ikhlas_school/data/fees/F' + i, { id: 'F' + i, studentId: String(1000 + i), amount: 1000, _o: i });
    put('ikhlas_school/data/payments/P' + i, { id: 'P' + i, feeId: 'F' + i, studentId: String(1000 + i), amount: 500, _o: i });
  }
  put('ikhlas_school/data/attendance/2026-11__9', { month: '2026-11', key: '9', days: { '2026-11-02': { a: ['1001'], l: [], n: {} }, '2026-11-03': { a: [], l: [], n: {} } } });
  put('ikhlas_school/data/attendance/2026-11__10', { month: '2026-11', key: '10', days: { '2026-11-02': { a: [], l: ['1002'], n: {} } } });
}

/* ---------- fake Google Drive + OAuth ---------- */
function makeFakeGoogle(opts = {}){
  const g = { files: new Map(), folders: new Map(), calls: [], tick: 0, opts, uploadFails: opts.uploadFails || 0, failStatus: opts.failStatus || 502, lostOnce: !!opts.lostOnce, partialOnce: !!opts.partialOnce, netErr: opts.netErr || 0, tokenFails: opts.tokenFails || 0, lostFolderOnce: !!opts.lostFolderOnce };
  const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  g.fetch = async (url, init = {}) => {
    if(g.netErr > 0){ g.netErr--; g.calls.push('NETWORK-ERROR'); throw new TypeError('fetch failed'); }
    const u = new URL(url), method = (init.method || 'GET').toUpperCase();
    g.calls.push(method + ' ' + u.pathname);
    if(u.host === 'oauth2.googleapis.com'){
      const p = new URLSearchParams(String(init.body));
      if(g.tokenFails > 0){ g.tokenFails--; return J(500, { error: 'backend_error' }); }
      if(opts.invalidGrant) return J(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      if(p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csecret-123456') return J(401, { error: 'invalid_client' });
      if(p.get('refresh_token') !== 'refresh-token-ABCDEF' || p.get('grant_type') !== 'refresh_token') return J(400, { error: 'invalid_grant' });
      return J(200, { access_token: 'access-1', expires_in: 3600 });
    }
    if((init.headers || {}).Authorization !== 'Bearer access-1') return J(401, { error: { message: 'unauth' } });
    if(u.pathname === '/upload/drive/v3/files' && method === 'POST'){
      if(opts.driveFull) return J(403, { error: { message: 'The user\'s Drive storage quota has been exceeded.' } });
      const raw = Buffer.from(init.body).toString('utf8');
      const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1];
      const parts = raw.split('--' + boundary).filter(x => x.trim() && x.trim() !== '--');
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());
      let content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n'); content = content.replace(/\r\n$/, '');
      const buf = Buffer.from(content, 'utf8');
      if(g.uploadFails > 0){ g.uploadFails--; return J(g.failStatus, { error: { message: 'Bad Gateway' } }); }
      const id = 'file' + (++g.tick);
      const md5 = crypto.createHash('md5').update(buf).digest('hex');
      g.files.set(id, { id, name: meta.name, parent: meta.parents[0], createdTime: new Date(Date.UTC(2026, 10, 1) + g.tick * 1000).toISOString(), content, size: buf.length, md5, trashed: false });
      if(g.partialOnce){ g.partialOnce = false; const f = g.files.get(id); f.content = f.content.slice(0, 20); f.size = Buffer.byteLength(f.content); f.md5 = crypto.createHash('md5').update(f.content).digest('hex'); return J(502, { error: { message: 'Bad Gateway' } }); }
      if(g.lostOnce){ g.lostOnce = false; return J(502, { error: { message: 'Bad Gateway' } }); }
      return J(200, { id, name: meta.name, size: String(buf.length), md5Checksum: opts.badMd5 ? 'deadbeef' : md5 });
    }
    if(u.pathname === '/drive/v3/files' && method === 'POST'){
      const b = JSON.parse(init.body); const id = 'folder' + (++g.tick);
      g.folders.set(id, { id, name: b.name, trashed: false });
      if(g.lostFolderOnce){ g.lostFolderOnce = false; return J(502, { error: { message: 'Bad Gateway' } }); }
      return J(200, { id });
    }
    if(u.pathname === '/drive/v3/files' && method === 'GET'){
      const q = u.searchParams.get('q') || '';
      if(q.includes('application/vnd.google-apps.folder')){
        return J(200, { files: [...g.folders.values()].filter(f => !f.trashed && q.includes("name='" + f.name + "'")) });
      }
      const parent = /'([^']+)' in parents/.exec(q)[1];
      if(!q.includes('name contains')){
        const nm = /name='([^']+)'/.exec(q)[1];
        const hit = [...g.files.values()].filter(f => f.name === nm && f.parent === parent && !f.trashed);
        return J(200, { files: hit.map(f => ({ id: f.id, name: f.name, size: String(f.size), md5Checksum: f.md5 })) });
      }
      let list = [...g.files.values()].filter(f => f.parent === parent && !f.trashed && f.name.includes(FILE_PREFIX)).sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));
      const size = 2, start = Number(u.searchParams.get('pageToken') || 0);
      const page = list.slice(start, start + size);
      return J(200, { files: page.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })), nextPageToken: start + size < list.length ? String(start + size) : undefined });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if(m && method === 'GET'){ const f = g.folders.get(m[1]); return f ? J(200, { id: f.id, trashed: f.trashed, mimeType: 'application/vnd.google-apps.folder' }) : J(404, { error: { message: 'not found' } }); }
    if(m && method === 'DELETE'){ if(!g.files.has(m[1])) return J(404, {}); g.files.delete(m[1]); return J(204, {}); }
    return J(500, { error: { message: 'unhandled ' + method + ' ' + u.pathname } });
  };
  return g;
}
const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret-123456', GOOGLE_REFRESH_TOKEN: 'refresh-token-ABCDEF', BACKUP_KEEP: '30' };
const mkLog = () => { const l = []; const f = m => l.push(m); f.lines = l; return f; };
const backupsIn = g => [...g.files.values()].sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));
let passed = 0;
const t = async (name, fn) => { try{ await fn(); passed++; console.log('  ok  ' + name); }catch(e){ console.error('  FAIL  ' + name + '\n', e); process.exit(1); } };

(async () => {
  console.log('Schedule logic');
  await t('off / default / requested / intervals / manual', async () => {
    const now = 1_800_000_000_000;
    assert.strictEqual(decide({ schedule: 'off', lastBackupAt: 1 }, now).run, false);
    assert.strictEqual(decide({}, now).run, true, 'no backup yet -> run (default is daily)');
    assert.strictEqual(decide({ schedule: 'off' }, now, true).run, true, 'manual run ignores schedule');
    assert.strictEqual(decide({ schedule: 'off', lastBackupAt: now - 5 * DAY, requestedAt: now - HOUR }, now).run, true, 'requested in app');
    assert.strictEqual(decide({ schedule: '1d', lastBackupAt: now - 20 * HOUR }, now).run, false);
    assert.strictEqual(decide({ schedule: '1d', lastBackupAt: now - (24 * HOUR - SLACK) }, now).run, true);
    assert.strictEqual(decide({ schedule: '1w', lastBackupAt: now - 6 * DAY }, now).run, false);
    assert.strictEqual(decide({ schedule: '1w', lastBackupAt: now - 7 * DAY }, now).run, true);
    assert.strictEqual(decide({ schedule: '15d', lastBackupAt: now - 14 * DAY }, now).run, false);
    assert.strictEqual(decide({ schedule: '15d', lastBackupAt: now - 15 * DAY }, now).run, true);
    assert.strictEqual(decide({ schedule: '1m', lastBackupAt: now - 29 * DAY }, now).run, false);
    assert.strictEqual(decide({ schedule: '1m', lastBackupAt: now - 30 * DAY }, now).run, true);
    assert.strictEqual(decide({ schedule: 'bogus', lastBackupAt: now - 2 * DAY }, now).run, true, 'unknown value falls back to daily');
    assert.strictEqual(decide({ schedule: '1d', lastBackupAt: now - 40 * DAY, requestedAt: now - 50 * DAY }, now).reason.includes('requested'), false);
  });

  console.log('Rebuilding the data');
  await t('records are in order, bookkeeping fields removed, attendance merged, school settings recombined', async () => {
    const db = new MockDb(); seedCloud(db, 5);
    const cache = new Map(); db.store.forEach((v, k) => cache.set(k, v));
    const d = composeV2(cache);
    assert.deepStrictEqual(d.students.map(s => s.id), ['1005', '1004', '1003', '1002', '1001'], 'sorted by _o');
    assert.ok(!('_o' in d.students[0]) && !('_t' in d.students[0]) && !('_by' in d.students[0]));
    assert.deepStrictEqual(Object.keys(d.attendance).sort(), ['2026-11-02', '2026-11-03']);
    assert.deepStrictEqual(Object.keys(d.attendance['2026-11-02']).sort(), ['10', '9']);
    assert.strictEqual(d.school.mgmtPassword, 'm'); assert.strictEqual(d.school.name, 'Ikhlas'); assert.strictEqual(d.school.logo, 'data:image/png;base64,AAAA');
    assert.deepStrictEqual(d.alertLog, [{ id: 'A1', title: 't' }]);
  });

  console.log('Full runs');
  await t('first run: creates folder, uploads, verifies checksum, records status; file is restorable', async () => {
    const db = new MockDb(); seedCloud(db, 50); const g = makeFakeGoogle(); const log = mkLog();
    const now = Date.UTC(2026, 10, 2, 18, 30);   // 2 Nov 2026 18:30 UTC = 00:00 IST on the 3rd
    const r = await runBackup({ db, fetch: g.fetch, env: ENV, now, force: false, log });
    assert.ok(r.ok); assert.strictEqual(g.folders.size, 1); assert.strictEqual([...g.folders.values()][0].name, FOLDER_NAME);
    const files = backupsIn(g); assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, 'ikhlas-school-backup-2026-11-03-0000.json', 'file name uses India time');
    const data = JSON.parse(files[0].content);
    assert.ok(data.students && data.fees, 'passes the app\'s restore check');
    assert.strictEqual(data.students.length, 50); assert.strictEqual(data.payments.length, 50);
    const st = db.store.get('ikhlas_school/backup');
    assert.strictEqual(st.lastStatus, 'ok'); assert.strictEqual(st.lastBackupAt, now); assert.strictEqual(st.lastCounts.students, 50); assert.ok(st.folderId);
    const all = log.lines.join('\n');
    assert.ok(!/SecretName|1234 5678|mgmtPassword|refresh-token|csecret|access-1/.test(all), 'logs contain no student data or secrets');
  });
  await t('second run right away does nothing (no Drive calls, one Firestore read)', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle(); const now = Date.UTC(2026, 10, 2, 6);
    await runBackup({ db, fetch: g.fetch, env: ENV, now, force: false, log: mkLog() });
    const calls = g.calls.length; db.reads = 0;
    const r = await runBackup({ db, fetch: g.fetch, env: ENV, now: now + 6 * HOUR, force: false, log: mkLog() });
    assert.ok(r.skipped); assert.strictEqual(g.calls.length, calls); assert.strictEqual(db.reads, 1);
  });
  await t('"Back up now" from the app triggers a run; schedule triggers after the interval', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle(); let now = Date.UTC(2026, 10, 2, 6);
    await runBackup({ db, fetch: g.fetch, env: ENV, now, log: mkLog() });
    await db.doc('ikhlas_school/backup').set({ schedule: '1w', requestedAt: now + HOUR }, { merge: true });
    let r = await runBackup({ db, fetch: g.fetch, env: ENV, now: now + 2 * HOUR, log: mkLog() }); assert.ok(r.ok, 'requested');
    assert.strictEqual(backupsIn(g).length, 2);
    r = await runBackup({ db, fetch: g.fetch, env: ENV, now: now + 3 * DAY, log: mkLog() }); assert.ok(r.skipped, 'weekly: not yet');
    r = await runBackup({ db, fetch: g.fetch, env: ENV, now: now + 2 * HOUR + 7 * DAY, log: mkLog() }); assert.ok(r.ok, 'weekly: due');
  });
  await t('keeps only the newest N backups (paged listing)', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle(); const env = Object.assign({}, ENV, { BACKUP_KEEP: '3' });
    for(let i = 0; i < 6; i++) await runBackup({ db, fetch: g.fetch, env, now: Date.UTC(2026, 10, 2 + i, 6), force: true, log: mkLog() });
    const f = backupsIn(g); assert.strictEqual(f.length, 3);
    assert.deepStrictEqual(f.map(x => x.name.slice(-20, -5)), ['2026-11-07-1130', '2026-11-06-1130', '2026-11-05-1130']);
  });
  await t('if the data suddenly shrinks: still saved, but NOTHING is deleted and a warning is recorded', async () => {
    const db = new MockDb(); seedCloud(db, 100); const g = makeFakeGoogle(); const env = Object.assign({}, ENV, { BACKUP_KEEP: '3' });
    for(let i = 0; i < 3; i++) await runBackup({ db, fetch: g.fetch, env, now: Date.UTC(2026, 10, 2 + i, 6), force: true, log: mkLog() });
    for(let i = 11; i <= 100; i++){ db.store.delete('ikhlas_school/data/students/' + (1000 + i)); }
    const r = await runBackup({ db, fetch: g.fetch, env, now: Date.UTC(2026, 10, 9, 6), force: true, log: mkLog() });
    assert.ok(r.ok && r.warning); assert.strictEqual(backupsIn(g).length, 4, 'older backups kept');
    assert.ok(db.store.get('ikhlas_school/backup').lastWarning);
  });
  await t('works from the old single-document layout too', async () => {
    const db = new MockDb(); const g = makeFakeGoogle();
    db.store.set('ikhlas_school/main', { payload: JSON.stringify({ students: [{ id: '1' }], fees: [], payments: [], attendance: {} }), updatedAt: 1 });
    const r = await runBackup({ db, fetch: g.fetch, env: ENV, now: Date.UTC(2026, 10, 2), log: mkLog() });
    assert.ok(r.ok); assert.strictEqual(db.store.get('ikhlas_school/backup').lastSource, 'old single document');
  });

  console.log('Failure handling');
  await t('revoked/expired Google approval: clear message, recorded, secrets never shown', async () => {
    const db = new MockDb(); seedCloud(db, 5); const g = makeFakeGoogle({ invalidGrant: true });
    await assert.rejects(runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12, log: mkLog() }), e => /invalid_grant/.test(e.message) && e.reported);
    const st = db.store.get('ikhlas_school/backup'); assert.strictEqual(st.lastStatus, 'error'); assert.ok(!st.lastBackupAt);
    assert.ok(!/refresh-token|csecret/.test(JSON.stringify(st)));
  });
  await t('wrong client secret is reported clearly', async () => {
    const db = new MockDb(); seedCloud(db, 5); const g = makeFakeGoogle();
    await assert.rejects(runBackup({ db, fetch: g.fetch, env: Object.assign({}, ENV, { GOOGLE_CLIENT_SECRET: 'wrong-secret-xyz' }), now: 1e12, log: mkLog() }), /invalid_client/);
  });
  await t('checksum mismatch: not trusted, nothing pruned, failure recorded', async () => {
    const db = new MockDb(); seedCloud(db, 5); const g = makeFakeGoogle({ badMd5: true });
    await assert.rejects(runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }), /checksum/);
    assert.strictEqual(db.store.get('ikhlas_school/backup').lastStatus, 'error');
    assert.ok(!g.calls.some(c => c.startsWith('DELETE')));
  });
  await t('Drive full is explained in plain words', async () => {
    const db = new MockDb(); seedCloud(db, 5); const g = makeFakeGoogle({ driveFull: true });
    await assert.rejects(runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }), /Drive is full/);
  });
  await t('backup folder deleted in Drive: a new one is created and remembered', async () => {
    const db = new MockDb(); seedCloud(db, 5); const g = makeFakeGoogle();
    await runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() });
    const old = db.store.get('ikhlas_school/backup').folderId; g.folders.get(old).trashed = true;
    await runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12 + DAY, force: true, log: mkLog() });
    assert.notStrictEqual(db.store.get('ikhlas_school/backup').folderId, old); assert.strictEqual(g.folders.size, 2);
  });
  await t('an empty database is refused (no pointless backup)', async () => {
    const db = new MockDb(); const g = makeFakeGoogle();
    await assert.rejects(runBackup({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }), /No school data/);
  });

  console.log('Temporary Google problems');
  const fast = { sleep: async () => {} };
  const uploads = g => g.calls.filter(c => c === 'POST /upload/drive/v3/files').length;
  await t('a temporary 502 on upload is retried and the backup still succeeds (one file only)', async () => {
    const db = new MockDb(); seedCloud(db, 20); const g = makeFakeGoogle({ uploadFails: 2 }); const log = mkLog();
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log }, fast));
    assert.ok(r.ok); assert.strictEqual(backupsIn(g).length, 1); assert.strictEqual(uploads(g), 3);
    assert.ok(log.lines.some(l => /temporary problem \(upload\)/.test(l)) && log.lines.some(l => /try 3 of 4/.test(l)));
    assert.strictEqual(db.store.get('ikhlas_school/backup').lastStatus, 'ok');
  });
  await t('Google saved the file but the reply was lost (502): no duplicate is created', async () => {
    const db = new MockDb(); seedCloud(db, 20); const g = makeFakeGoogle({ lostOnce: true });
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast));
    assert.ok(r.ok); assert.strictEqual(backupsIn(g).length, 1, 'exactly one backup file'); assert.strictEqual(uploads(g), 1, 'the file was not uploaded twice');
  });
  await t('a half-written file from the failed try is replaced by the complete one', async () => {
    const db = new MockDb(); seedCloud(db, 20); const g = makeFakeGoogle({ partialOnce: true });
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast));
    const files = backupsIn(g); assert.ok(r.ok); assert.strictEqual(files.length, 1);
    assert.strictEqual(JSON.parse(files[0].content).students.length, 20, 'the saved file is complete');
  });
  await t('if Google keeps failing: gives up after 4 tries with a plain message and records it', async () => {
    const db = new MockDb(); seedCloud(db, 20); const g = makeFakeGoogle({ uploadFails: 99 });
    await assert.rejects(runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast)), e => /upload failed \(502/.test(e.message) && /4 times in a row/.test(e.message) && /again in a few minutes/.test(e.message));
    assert.strictEqual(uploads(g), 4); assert.strictEqual(backupsIn(g).length, 0);
    const st = db.store.get('ikhlas_school/backup'); assert.strictEqual(st.lastStatus, 'error'); assert.ok(!st.lastBackupAt);
  });
  await t('network hiccups and a sign-in hiccup are retried', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle({ netErr: 2, tokenFails: 1 });
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast));
    assert.ok(r.ok); assert.strictEqual(backupsIn(g).length, 1);
  });
  await t('a rate-limit answer (429) is retried', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle({ uploadFails: 1, failStatus: 429 });
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast));
    assert.ok(r.ok); assert.strictEqual(uploads(g), 2);
  });
  await t('the backup folder is never duplicated when the folder reply is lost', async () => {
    const db = new MockDb(); seedCloud(db, 10); const g = makeFakeGoogle({ lostFolderOnce: true });
    const r = await runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast));
    assert.ok(r.ok); assert.strictEqual(g.folders.size, 1);
  });
  await t('permanent problems are NOT retried (revoked approval, Drive full)', async () => {
    let db = new MockDb(); seedCloud(db, 10); let g = makeFakeGoogle({ invalidGrant: true });
    await assert.rejects(runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast)), /invalid_grant/);
    assert.strictEqual(g.calls.filter(c => c.includes('/token')).length, 1);
    db = new MockDb(); seedCloud(db, 10); g = makeFakeGoogle({ driveFull: true });
    await assert.rejects(runBackup(Object.assign({ db, fetch: g.fetch, env: ENV, now: 1e12, force: true, log: mkLog() }, fast)), /Drive is full/);
    assert.strictEqual(uploads(g), 1);
  });
  console.log('\n' + passed + ' backup checks passed');
})();
