// Apps Script のサービスを最小限まねして、GAS のコードを Node で動かすテスト。
// 実行: node tests/gas_harness.js （どのタイムゾーンでも同じ結果になること）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const J = (y, m, d, hh, mi) => new Date(Date.UTC(y, m, d, hh - 9, mi)); // 日本時間で日時を作る
let NOW = J(2026, 9, 28, 10, 0); // 2026-10-28 (水) 10:00
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
  static now() { return NOW.getTime(); }
}

// ---- Spreadsheet ----
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(((this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]) ?? '');
      out.push(row);
    }
    return out;
  }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sh.set(this.r, this.c, x); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setDataValidation() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); this.data[r - 1][c - 1] = v; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(row) { this.data.push(row.slice()); }
  setFrozenRows() {}
}
const book = { sheets: {}, getSheetByName(n) { return this.sheets[n] || null; },
  insertSheet(n) { return (this.sheets[n] = new Sheet(n)); }, getId() { return 'BOOK1'; } };

// ---- Drive ----
let idSeq = 0;
class DFile {
  constructor(name, parent, updated) { this.id = 'F' + (++idSeq); this.name = name; this.parent = parent; this.updated = updated; parent.files.push(this); }
  getId() { return this.id; } getName() { return this.name; } getLastUpdated() { return this.updated; }
  moveTo(f) { this.parent.files = this.parent.files.filter(x => x !== this); this.parent = f; f.files.push(this); }
}
class DFolder {
  constructor(name) { this.id = 'D' + (++idSeq); this.name = name; this.files = []; this.folders = []; folders[this.id] = this; }
  getId() { return this.id; } getName() { return this.name; }
  createFolder(n) { const f = new DFolder(n); this.folders.push(f); return f; }
  getFiles() { const a = this.files.slice(); return { hasNext: () => a.length > 0, next: () => a.shift() }; }
  getFolders() { const a = this.folders.slice(); return { hasNext: () => a.length > 0, next: () => a.shift() }; }
  setTrashed() {}
}
const folders = {};

// ---- Fetch ----
const calls = [];
function fakeFetch(url, opt) {
  opt = opt || {};
  calls.push({ url, opt });
  let code = 200, body = { ok: true };
  if (url.includes('api.github.com') && url.endsWith('/dispatches')) code = 204;
  if (url.includes('graph.threads.net') && url.includes('/threads_publish')) body = { id: 'TH_PUB_1' };
  else if (url.includes('graph.threads.net') && url.includes('/threads')) body = { id: 'TH_C_1' };
  else if (url.includes('graph.threads.net')) body = { permalink: 'https://threads.net/p/1' };
  return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
}

const props = {};
const ctx = {
  Date: FakeDate, console, JSON, Math, String, Number, Object, Array, RegExp, parseInt, encodeURIComponent, Infinity,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
    deleteProperty: k => { delete props[k]; } }) },
  SpreadsheetApp: {
    getActive: () => book, openById: () => book,
    getUi: () => ({ alert: m => { ctx._alerts.push(m); }, createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) }),
    newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } })
  },
  DriveApp: { createFolder: n => new DFolder(n), getFolderById: id => folders[id] },
  UrlFetchApp: { fetch: fakeFetch },
  Utilities: {
    sleep() {},
    formatDate(d0, tz, p) {
      const x = new RealDate(d0.getTime() + 9 * 3600000);
      const d = { getFullYear: () => x.getUTCFullYear(), getMonth: () => x.getUTCMonth(), getDate: () => x.getUTCDate(),
        getHours: () => x.getUTCHours(), getMinutes: () => x.getUTCMinutes(), getSeconds: () => x.getUTCSeconds() };
      const pad = (n, l = 2) => String(n).padStart(l, '0');
      const map = { yyyy: d.getFullYear(), yy: pad(d.getFullYear() % 100), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
        dd: pad(d.getDate()), d: d.getDate(), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
      return p.replace(/yyyy|yy|MM|M|dd|d|HH|mm|ss/g, t => map[t]);
    }
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getOAuthToken: () => 'DRIVE_TOKEN', getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }),
    getProjectTriggers: () => [], newTrigger: () => ({ timeBased() { return this; }, everyMinutes() { return this; }, everyDays() { return this; }, atHour() { return this; }, create() {} }) },
  ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  HtmlService: { createHtmlOutput: h => ({ html: h }) },
  _alerts: []
};
vm.createContext(ctx);
const dir = path.join(__dirname, '..', 'gas');
for (const f of ['Config.gs', 'Sheets.gs', 'Social.gs', 'Line.gs', 'Main.gs', 'WebApp.gs', 'Setup.gs']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const run = code => vm.runInContext(code, ctx);
const post = (body, params) => JSON.parse(run('doPost')({ parameter: params || {}, postData: { contents: JSON.stringify(body) } }).text);
const lineEvent = (uid, ev) => post({ events: [Object.assign({ source: { userId: uid }, replyToken: 'RT' }, ev)] }, { line: props.LINE_WEBHOOK_KEY });
const lastLine = kind => { const c = calls.filter(c => c.url.includes('api.line.me/v2/bot/message/' + kind)).pop(); return c && JSON.parse(c.opt.payload); };
const rows = name => run(`rows_(${JSON.stringify(name)})`);

// 1. 初期設定
run('setupAll()');
props.GH_REPO = 'me/fudosan-auto'; props.GH_TOKEN = 'ghp'; props.LINE_TOKEN = 'lt';
assert.ok(props.FOLDER_INBOX && props.GAS_SECRET);
assert.strictEqual(rows('物件台帳').length, 1);

// 2. オーナー登録
lineEvent('OWNER', { type: 'message', message: { type: 'text', text: '登録 ' + props.OWNER_CODE } });
assert.strictEqual(props.OWNER_LINE_USER_ID, 'OWNER');

// 3. 新着動画（アップロード直後は待つ → 時間がたったら処理）
const inbox = folders[props.FOLDER_INBOX];
new DFile('P001 外観.mp4', inbox, new RealDate(NOW.getTime() - 60000));
new DFile('P001 室内.mov', inbox, new RealDate(NOW.getTime() - 60000));
run('tick()');
assert.strictEqual(rows('動画').length, 0, 'アップロード直後は処理しない');
NOW = new RealDate(NOW.getTime() + 10 * 60000);
run('tick()');
let v = rows('動画');
assert.strictEqual(v.length, 1);
assert.strictEqual(v[0]['状態'], '編集中');
assert.strictEqual(JSON.parse(v[0]['素材']).length, 2);
assert.strictEqual(inbox.files.length, 0, '素材は保管フォルダへ移動');
const disp = calls.filter(c => c.url.endsWith('/dispatches')).pop();
assert.deepStrictEqual(JSON.parse(disp.opt.payload), { event_type: 'render', client_payload: { job_id: 'V0001' } });

// 4. 未登録の物件ID
new DFile('P999 外観.mp4', inbox, new RealDate(NOW.getTime() - 3600000));
run('tick()');
assert.ok(lastLine('push').messages[0].text.includes('P999'));

// 5. GitHub からの問い合わせ
assert.strictEqual(post({ key: 'wrong', action: 'get_render_job', job_id: 'V0001' }).ok, false);
const job = post({ key: props.GAS_SECRET, action: 'get_render_job', job_id: 'V0001' });
assert.ok(job.ok);
assert.strictEqual(job.property.id, 'P001');
assert.strictEqual(job.property.station_m, 640);
assert.strictEqual(job.files.length, 2);
post({ key: props.GAS_SECRET, action: 'render_done', job_id: 'V0001', folder_id: 'OUT1',
  files: { reel: 'R1', carousel: ['C1', 'C2'], story: 'S1' },
  texts: { hook: '7.8万円で1LDK', reel_caption: 'リール文', carousel_caption: 'カルーセル文', threads_video: 'TV', threads_tip: 'TT' },
  warnings: [], meta: { reel_seconds: 30, photos: 5, mode: 'tour' } });
v = rows('動画');
assert.strictEqual(v[0]['状態'], '承認待ち');
assert.ok(lastLine('push').messages[0].text.includes('OK 1'));

// 6. LINE で承認（Threads は自動投稿オフ）
lineEvent('OWNER', { type: 'message', message: { type: 'text', text: 'ＯＫ　１' } });
assert.ok(lastLine('reply').messages[0].text.includes('予約しました'), lastLine('reply').messages[0].text);
let p = rows('投稿予定');
assert.deepStrictEqual(p.map(r => r['種類']).sort(), ['ig_carousel', 'ig_reel', 'ig_story']);
const reel = p.find(r => r['種類'] === 'ig_reel');
assert.strictEqual(run('fmt_')(reel['予定日時'], 'M/d HH:mm'), '10/28 19:00');

// 7. 予定時刻 → 投稿ジョブ
NOW = J(2026, 9, 28, 19, 6);
run('tick()');
p = rows('投稿予定');
const posting = p.filter(r => r['状態'] === '投稿中');
assert.strictEqual(posting.length, 2, 'リールとストーリーズ');
const pubJob = posting[0]['ジョブ'];
const pj = post({ key: props.GAS_SECRET, action: 'get_publish_job', job_id: pubJob });
assert.strictEqual(pj.posts.length, 2);
assert.strictEqual(pj.posts.find(x => x.type === 'ig_reel').caption, 'リール文');
assert.deepStrictEqual(pj.posts.find(x => x.type === 'ig_story').files.map(f => f.id), ['S1']);
post({ key: props.GAS_SECRET, action: 'publish_done', job_id: pubJob,
  results: pj.posts.map(x => ({ post_id: x.post_id, ok: true, media_id: 'M' + x.post_id, permalink: 'https://instagram.com/p/' + x.post_id })) });
p = rows('投稿予定');
assert.strictEqual(p.filter(r => r['状態'] === '投稿済み').length, 2);
assert.ok(lastLine('push').messages[0].text.includes('リールを投稿しました'));

// 8. 2本目は翌日の枠に入る
props.THREADS_AUTOPOST = 'true';
run(`append_('動画', {'動画No':'V0002','物件ID':'P001','状態':'承認待ち','完成ファイル':JSON.stringify({reel:'R2',carousel:['C'],story:''}),'Threadsコツ':'コツ'})`);
NOW = J(2026, 9, 28, 20, 0);
lineEvent('OWNER', { type: 'message', message: { type: 'text', text: 'OK 2' } });
p = rows('投稿予定').filter(r => r['動画No'] === 'V0002');
assert.deepStrictEqual(p.map(r => r['種類']).sort(), ['ig_carousel', 'ig_reel', 'threads_text', 'threads_video']);
assert.strictEqual(run('fmt_')(p.find(r => r['種類'] === 'ig_reel')['予定日時'], 'M/d HH:mm'), '10/29 19:00');
assert.strictEqual(run('fmt_')(p.find(r => r['種類'] === 'threads_text')['予定日時'], 'M/d HH:mm'), '10/30 07:40');

// 9. Threads 文章は GAS から直接投稿
NOW = J(2026, 9, 30, 7, 45);
props.THREADS_TOKEN = 'tt'; props.THREADS_USER_ID = 'TU';
run('publishDue()');
const tt = rows('投稿予定').find(r => r['動画No'] === 'V0002' && r['種類'] === 'threads_text');
assert.strictEqual(tt['状態'], '投稿済み');

// 10. お客様のアンケート
lineEvent('U1', { type: 'follow' });
assert.ok(lastLine('reply').messages[1].quickReply);
lineEvent('U1', { type: 'message', message: { type: 'text', text: '賃貸を探す' } });
lineEvent('U1', { type: 'message', message: { type: 'text', text: '中野駅' } });
lineEvent('U1', { type: 'message', message: { type: 'text', text: '6〜8万円' } });
lineEvent('U1', { type: 'message', message: { type: 'text', text: '1LDK' } });
const match = lastLine('reply').messages[0].text;
assert.ok(match.includes('サンプルマンション') && match.includes('7.8万円') && match.includes('徒歩8分'), match);
assert.ok(match.includes('instagram.com/p/'), 'リールのURLを案内');
lineEvent('U1', { type: 'message', message: { type: 'text', text: '初期費用はいくら？' } });
assert.ok(lastLine('reply').messages[0].text.includes('敷金'));
const pushesBefore = calls.filter(c => c.url.endsWith('/push')).length;
lineEvent('U2', { type: 'follow' });
lineEvent('U2', { type: 'message', message: { type: 'text', text: '購入を検討' } });
assert.strictEqual(calls.filter(c => c.url.endsWith('/push')).length, pushesBefore, 'お客様への返事はプッシュを使わない');

// 11. 成約
lineEvent('OWNER', { type: 'message', message: { type: 'text', text: '成約 P001' } });
const soldMsg = lastLine('reply').messages[0].text;
assert.ok(soldMsg.includes('成約にしました') && soldMsg.includes('アーカイブ'), soldMsg);
assert.ok(rows('投稿予定').filter(r => r['動画No'] === 'V0002' && r['状態'] === '予約済み').length === 0);

// 12. 不正な LINE 合言葉は無視
const n = calls.length;
post({ events: [{ type: 'follow', source: { userId: 'X' }, replyToken: 'R' }] }, { line: 'bad' });
assert.strictEqual(calls.length, n);

console.log('GAS harness: all checks passed');
