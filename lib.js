'use strict';
/* ===================================================================
   Ikhlas School Manager: scheduled backup of Firestore to Google Drive
   -------------------------------------------------------------------
   Reads the school's data (new one-document-per-record layout, or the
   old single document), rebuilds it into the SAME file format that
   Settings > "Download backup" produces, and uploads it to a private
   folder in Google Drive. Restore it with Settings > "Restore from backup".

   Nothing here prints student data: logs only contain counts and file
   names (this repository's Actions logs may be public).
   =================================================================== */
const crypto = require('crypto');

const BACKUP_DOC = 'ikhlas_school/backup';     // schedule (written by the app) + status (written here)
const FOLDER_NAME = 'Ikhlas School Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_PREFIX = 'ikhlas-school-backup-';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const INTERVALS = { '1d': DAY, '1w': 7 * DAY, '15d': 15 * DAY, '1m': 30 * DAY };
const SLACK = 3 * HOUR;                         // the job checks every 6 hours; allow half of that
const DEFAULT_SCHEDULE = '1d';
const ARRAY_COLS = ['students', 'fees', 'payments', 'expenses', 'exams'];
const COLS = ARRAY_COLS.concat(['attendance']);
const SINGLES = ['settings', 'secrets', 'branding', 'alerts'];
const META = ['_t', '_by', '_o'];
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

class BackupError extends Error {
  constructor(message, code){ super(message); this.name = 'BackupError'; this.code = code || 'error'; }
}

/* ---------- when is a backup due? ---------- */
function decide(cfg, now, force){
  cfg = cfg || {};
  const schedule = Object.prototype.hasOwnProperty.call(INTERVALS, cfg.schedule) || cfg.schedule === 'off' ? cfg.schedule : DEFAULT_SCHEDULE;
  const last = Number(cfg.lastBackupAt) || 0;
  if(force) return { run: true, reason: 'manual run', schedule };
  if(Number(cfg.requestedAt) > last) return { run: true, reason: '"Back up now" was requested in the app', schedule };
  if(schedule === 'off') return { run: false, reason: 'automatic backup is switched off in the app', schedule };
  if(!last) return { run: true, reason: 'no backup has been made yet', schedule };
  const due = last + INTERVALS[schedule] - SLACK;
  if(now >= due) return { run: true, reason: 'scheduled (' + schedule + ')', schedule };
  return { run: false, reason: 'not due yet (next about ' + new Date(last + INTERVALS[schedule]).toISOString() + ')', schedule };
}

/* ---------- Firestore -> the app's own data shape ---------- */
function strip(data){
  const o = {};
  Object.keys(data || {}).forEach(k => { if(META.indexOf(k) < 0) o[k] = data[k]; });
  return o;
}
// Same rules as the app (cloudCompose in app.js), so a backup equals what the app shows.
function composeV2(cache){
  const buckets = {};
  ARRAY_COLS.forEach(c => { buckets[c] = []; });
  const out = { school: {}, students: [], fees: [], payments: [], expenses: [], exams: [], attendance: {}, alertSettings: {}, alertLog: [], deletedStudents: {} };
  let settings = {}, secrets = {}, branding = {};
  cache.forEach((data, path) => {
    const parts = path.split('/');
    if(parts.length === 2){
      const d = strip(data);
      if(parts[1] === 'settings') settings = d;
      else if(parts[1] === 'secrets') secrets = d;
      else if(parts[1] === 'branding') branding = d;
      else if(parts[1] === 'alerts') out.alertLog = Array.isArray(d.log) ? d.log : [];
      return;
    }
    const col = parts[2];
    if(col === 'attendance'){
      const d = strip(data);
      Object.keys(d.days || {}).forEach(date => {
        if(!out.attendance[date]) out.attendance[date] = {};
        out.attendance[date][d.key] = d.days[date];
      });
    }else if(buckets[col]){
      buckets[col].push({ rec: strip(data), o: typeof data._o === 'number' ? data._o : Infinity, key: parts[3] });
    }
  });
  ARRAY_COLS.forEach(col => {
    buckets[col].sort((a, b) => a.o === b.o ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : (a.o < b.o ? -1 : 1));
    out[col] = buckets[col].map(x => x.rec);
  });
  out.school = Object.assign({}, settings.school || {}, secrets, { logo: branding.logo || '' });
  out.alertSettings = settings.alertSettings || {};
  out.deletedStudents = settings.deletedStudents || {};
  return out;
}
async function readCloud(db){
  const cache = new Map();
  for(const name of SINGLES){
    const s = await db.doc('ikhlas_school/' + name).get();
    if(s.exists) cache.set('ikhlas_school/' + name, s.data());
  }
  for(const col of COLS){
    const q = await db.collection('ikhlas_school/data/' + col).get();
    q.docs.forEach(d => cache.set('ikhlas_school/data/' + col + '/' + d.id, d.data()));
  }
  return cache;
}
async function loadSchoolData(db){
  const cache = await readCloud(db);
  const settings = cache.get('ikhlas_school/settings');
  if(settings && settings.schemaVersion >= 2) return { source: 'one document per record', data: composeV2(cache) };
  const main = await db.doc('ikhlas_school/main').get();
  if(main.exists && main.data() && main.data().payload){
    let data;
    try{ data = JSON.parse(main.data().payload); }catch(e){ throw new BackupError('The old ikhlas_school/main document could not be read.', 'bad_main'); }
    return { source: 'old single document', data };
  }
  throw new BackupError('No school data was found in this Firestore database. Check that FIREBASE_SERVICE_ACCOUNT belongs to the same Firebase project as the app.', 'no_data');
}
function countsOf(d){
  return {
    students: (d.students || []).length, fees: (d.fees || []).length, payments: (d.payments || []).length,
    expenses: (d.expenses || []).length, exams: (d.exams || []).length, attendanceDays: Object.keys(d.attendance || {}).length
  };
}

/* ---------- Google Drive (OAuth refresh token, scope drive.file) ---------- */
// Temporary Google problems (502/503, rate limits, network hiccups) are retried automatically.
function makeDrive({ fetch, clientId, clientSecret, refreshToken, sleep, delays, onRetry, timeoutMs }){
  sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  delays = delays || [2000, 6000, 15000];            // up to 4 tries in total
  timeoutMs = timeoutMs || 60000;
  let access = null;

  const isNetwork = e => e && !(e instanceof BackupError) &&
    (e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(e.message)));
  async function withRetry(what, fn){
    for(let i = 0; ; i++){
      try{ return await fn(i); }
      catch(e){
        const transient = (e instanceof BackupError && e.retryable) || isNetwork(e);
        if(!transient) throw e;
        if(i >= delays.length){
          if(e instanceof BackupError){
            e.message += ' It failed ' + (i + 1) + ' times in a row. This is usually a temporary Google problem: run the backup again in a few minutes.';
            throw e;
          }
          throw new BackupError('Could not reach Google Drive for the ' + what + ' (network problem). Run the backup again in a few minutes.', 'network');
        }
        if(onRetry) onRetry(what, i + 1, delays[i]);
        await sleep(delays[i]);
      }
    }
  }
  const send = (url, init) => fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(timeoutMs) }));

  async function token(){
    if(access) return access;
    access = await withRetry('sign-in', async () => {
      const r = await send('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString()
      });
      let j = {};
      try{ j = await r.json(); }catch(e){}
      if(!r.ok || !j.access_token){
        if(j.error === 'invalid_grant') throw new BackupError('Google no longer accepts the saved approval (invalid_grant). It was revoked, or the Google Cloud app is still in "Testing" mode (approvals then expire after 7 days). Repeat the one-time Google approval and update the GOOGLE_REFRESH_TOKEN secret.', 'invalid_grant');
        if(j.error === 'invalid_client') throw new BackupError('Google rejected GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (invalid_client). Check both secrets.', 'invalid_client');
        const e = new BackupError('Could not get a Google access token (' + (j.error || r.status) + ').', 'token');
        e.retryable = r.status === 429 || r.status >= 500;
        throw e;
      }
      return j.access_token;
    });
    return access;
  }
  async function api(url, opts){
    const t = await token();
    opts = opts || {};
    return send(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {}) }));
  }
  async function ok(r, what){
    if(r.ok) return r.status === 204 ? {} : r.json();
    let msg = '';
    try{ const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || ''; }catch(e){}
    if(r.status === 403 && /storage\s*quota|storageQuota/i.test(String(msg))) throw new BackupError('Your Google Drive is full. Free some space and run the backup again.', 'drive_full');
    const e = new BackupError('Google Drive ' + what + ' failed (' + r.status + (msg ? ': ' + String(msg).slice(0, 160) : '') + ').', 'drive_' + r.status);
    e.retryable = r.status === 429 || r.status === 408 || r.status >= 500 || (r.status === 403 && /rate\s*limit/i.test(String(msg)));
    throw e;
  }
  const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function removeFile(id){
    const r = await api(DRIVE + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
    if(!r.ok && r.status !== 404) await ok(r, 'delete');
  }
  return {
    async ensureFolder(knownId){
      if(knownId){
        const found = await withRetry('folder check', async () => {
          const r = await api(DRIVE + '/files/' + encodeURIComponent(knownId) + '?fields=id,trashed,mimeType');
          if(r.ok){
            const j = await r.json();
            return (!j.trashed && j.mimeType === FOLDER_MIME) ? { id: j.id, created: false } : null;
          }
          if(r.status === 404) return null;
          return ok(r, 'folder lookup');
        });
        if(found) return found;
      }
      // Each try searches first, so a folder created by an earlier try (whose answer got lost) is reused, never duplicated.
      return withRetry('folder setup', async () => {
        const s = await ok(await api(DRIVE + '/files?fields=files(id,name)&pageSize=10&q=' + encodeURIComponent("name='" + q(FOLDER_NAME) + "' and mimeType='" + FOLDER_MIME + "' and trashed=false")), 'folder search');
        if(s.files && s.files.length) return { id: s.files[0].id, created: false };
        const c = await ok(await api(DRIVE + '/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }) }), 'folder creation');
        return { id: c.id, created: true };
      });
    },
    async upload(folderId, name, buffer){
      const md5 = crypto.createHash('md5').update(buffer).digest('hex');
      const size = String(buffer.length);
      return withRetry('upload', async (attempt) => {
        if(attempt > 0){
          // Google can report an error even though it saved the file. Look first, so we never create a duplicate.
          const s = await ok(await api(DRIVE + '/files?fields=files(id,name,size,md5Checksum)&pageSize=10&q=' + encodeURIComponent("name='" + q(name) + "' and '" + q(folderId) + "' in parents and trashed=false")), 'upload check');
          const files = s.files || [];
          const same = files.find(f => String(f.size) === size && (!f.md5Checksum || f.md5Checksum === md5));
          if(same) return { id: same.id, name: same.name, size: same.size, md5Checksum: same.md5Checksum };
          for(const f of files) await removeFile(f.id);        // incomplete leftovers of the failed try
        }
        const boundary = 'ikhlas' + crypto.randomBytes(12).toString('hex');
        const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' }) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n';
        const body = Buffer.concat([Buffer.from(head), buffer, Buffer.from('\r\n--' + boundary + '--')]);
        return ok(await api(UPLOAD + '?uploadType=multipart&fields=id,name,size,md5Checksum', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }), 'upload');
      });
    },
    async listBackups(folderId){
      return withRetry('listing', async () => {
        let all = [], page = '';
        do{
          const url = DRIVE + '/files?fields=nextPageToken,files(id,name,createdTime)&pageSize=200&orderBy=' + encodeURIComponent('createdTime desc') +
            '&q=' + encodeURIComponent("'" + q(folderId) + "' in parents and trashed=false and name contains '" + FILE_PREFIX + "'") + (page ? '&pageToken=' + encodeURIComponent(page) : '');
          const j = await ok(await api(url), 'listing');
          all = all.concat(j.files || []);
          page = j.nextPageToken || '';
        }while(page);
        return all.filter(f => f.name.startsWith(FILE_PREFIX) && f.name.endsWith('.json'));
      });
    },
    async remove(id){ return withRetry('delete', () => removeFile(id)); }
  };
}

/* ---------- helpers ---------- */
function stamp(ms){
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + '-' + p.hour + p.minute;
}
function redactor(secrets){
  const list = secrets.filter(s => s && String(s).length > 6).map(String);
  return text => list.reduce((t, s) => t.split(s).join('[hidden]'), String(text));
}

/* ---------- the whole job ---------- */
async function runBackup({ db, fetch, env, now, force, log, sleep, delays }){
  const hide = redactor([env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN, env.GOOGLE_CLIENT_ID]);
  const ref = db.doc(BACKUP_DOC);
  const cfg = (await ref.get()).data() || {};
  const d = decide(cfg, now, force);
  if(!d.run){ log('No backup needed: ' + d.reason + '.'); return { skipped: true, reason: d.reason }; }
  log('Backup starting: ' + d.reason + '.');
  try{
    const { source, data } = await loadSchoolData(db);
    if(!Array.isArray(data.students) || !Array.isArray(data.fees)) throw new BackupError('The data looks incomplete (no students/fees lists), so no backup was made.', 'incomplete');
    const counts = countsOf(data);
    log('Read ' + counts.students + ' students, ' + counts.fees + ' fees, ' + counts.payments + ' payments, ' + counts.expenses + ' expenses, ' + counts.exams + ' exams, ' + counts.attendanceDays + ' attendance days (' + source + ').');
    const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');

    // If the school data suddenly looks much smaller than at the last backup, still save it,
    // but keep every older backup (do not delete anything) and tell the admin.
    const prev = cfg.lastCounts || {};
    const shrank = (prev.students > 0 && counts.students < prev.students * 0.5) || (prev.payments > 20 && counts.payments < prev.payments * 0.5);
    const drive = makeDrive({
      fetch, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN, sleep, delays,
      onRetry: (what, n, ms) => log('Google Drive had a temporary problem (' + what + '). Trying again in ' + Math.round(ms / 1000) + ' s (try ' + (n + 1) + ' of 4).')
    });
    const folder = await drive.ensureFolder(cfg.folderId);
    if(folder.created) log('Created the Drive folder "' + FOLDER_NAME + '".');
    const name = FILE_PREFIX + stamp(now) + '.json';
    const file = await drive.upload(folder.id, name, buffer);
    if(String(file.size) !== String(buffer.length) || (file.md5Checksum && file.md5Checksum !== md5)){
      throw new BackupError('Drive reported a different file size/checksum than expected, so the upload is not trusted. The older backups were kept.', 'verify');
    }
    log('Uploaded ' + name + ' (' + Math.round(buffer.length / 1024) + ' KB) and verified its checksum.');

    let pruned = 0, warning = null;
    if(shrank){
      warning = 'The school data is much smaller than at the previous backup (students ' + (prev.students || 0) + ' to ' + counts.students + '). Older backups were NOT deleted. Please check the data.';
      log('WARNING: ' + warning);
    }else{
      const keep = Math.min(365, Math.max(3, parseInt(env.BACKUP_KEEP, 10) || 30));
      const files = await drive.listBackups(folder.id);
      for(const f of files.slice(keep)){
        if(f.id === file.id) continue;
        try{ await drive.remove(f.id); pruned++; }catch(e){ log('Could not delete an old backup (' + f.name + ').'); }
      }
      if(pruned) log('Removed ' + pruned + ' old backup(s); keeping the newest ' + keep + '.');
    }
    await ref.set({
      lastBackupAt: now, lastRunAt: now, lastStatus: 'ok', lastError: null, lastWarning: warning,
      lastFile: name, lastBytes: buffer.length, lastCounts: counts, lastSource: source, folderId: folder.id
    }, { merge: true });
    return { ok: true, name, counts, pruned, warning };
  }catch(err){
    const message = hide(err && err.message ? err.message : 'Unexpected error').slice(0, 400);
    log('BACKUP FAILED: ' + message);
    try{ await ref.set({ lastRunAt: now, lastStatus: 'error', lastError: message }, { merge: true }); }catch(e){ log('(Could not record the failure in Firestore.)'); }
    const e = new BackupError(message, err && err.code); e.reported = true;
    throw e;
  }
}

module.exports = { runBackup, decide, composeV2, loadSchoolData, countsOf, makeDrive, stamp, BackupError, BACKUP_DOC, FOLDER_NAME, FILE_PREFIX, INTERVALS, SLACK };
