/**
 * 自動実行の本体。tick() が10分ごとに動きます。
 *  1. 投稿待ちフォルダの新着動画 → 編集を依頼
 *  2. 予定時刻になった投稿 → 投稿を依頼
 *  3. 成約になった物件 → 予約の取り消しと投稿の整理
 *  4. 止まったままの処理 → 失敗として通知
 */

function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    safe_(checkNewVideos, '新着チェック');
    safe_(publishDue, '予約投稿');
    safe_(syncSold, '成約チェック');
    safe_(watchdog, '見張り');
  } finally {
    lock.releaseLock();
  }
}

function safe_(fn, label) {
  try { fn(); } catch (e) { log_(label + 'でエラー: ' + (e && e.stack || e)); }
}

// ---------------- 1. 新着動画 ----------------

var VIDEO_RE = /\.(mp4|mov|m4v|avi|mkv|mts|3gp|webm)$/i;

function checkNewVideos() {
  var inbox = DriveApp.getFolderById(prop_('FOLDER_INBOX'));
  var settle = now_().getTime() - CONFIG.SETTLE_MINUTES * 60000;
  var groups = {};  // 物件ID → [File]

  // 物件IDの名前を付けたフォルダ（複数クリップ用）
  var folders = inbox.getFolders();
  while (folders.hasNext()) {
    var fd = folders.next();
    var files = [], fresh = false, it = fd.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (!VIDEO_RE.test(f.getName())) continue;
      if (f.getLastUpdated().getTime() > settle) fresh = true;
      files.push(f);
    }
    if (files.length && !fresh) groups['DIR:' + fd.getId()] = { id: fd.getName().trim(), files: files, folder: fd };
  }
  // 直接置いたファイル（「P001 外観.mp4」のように物件IDで始める）
  var it2 = inbox.getFiles();
  var loose = {};
  while (it2.hasNext()) {
    var f2 = it2.next();
    if (!VIDEO_RE.test(f2.getName())) continue;
    var m = f2.getName().match(/^([A-Za-z]*\d+)/);
    var pid = m ? m[1] : '';
    (loose[pid] = loose[pid] || []).push(f2);
  }
  Object.keys(loose).forEach(function (pid) {
    var fs = loose[pid];
    var fresh2 = fs.some(function (f) { return f.getLastUpdated().getTime() > settle; });
    if (!fresh2) groups['ID:' + pid] = { id: pid, files: fs };
  });

  Object.keys(groups).forEach(function (k) { startVideo_(groups[k]); });
}

function startVideo_(g) {
  var prow = g.id ? findRow_(CONFIG.SHEETS.PROPS, '物件ID', g.id) : null;
  if (!prow) {
    var warned = prop_('WARNED_' + g.id);
    if (!warned) {
      notifyOwner_('⚠ 物件ID「' + (g.id || '（なし）') + '」が物件台帳にありません。\n' +
        'ファイル名を「物件ID 説明.mp4」にするか、台帳に物件を追加してください。\n' +
        g.files.map(function (f) { return '・' + f.getName(); }).join('\n'));
      setProp_('WARNED_' + g.id, '1');
    }
    return;
  }
  var no = nextId_(CONFIG.SHEETS.VIDEOS, '動画No', 'V');
  var keep = DriveApp.getFolderById(prop_('FOLDER_SOURCE')).createFolder(no + '_' + g.id);
  g.files.forEach(function (f) { f.moveTo(keep); });
  if (g.folder) g.folder.setTrashed(true);
  append_(CONFIG.SHEETS.VIDEOS, {
    '動画No': no, '物件ID': g.id, '状態': '編集中',
    '素材': JSON.stringify(g.files.map(function (f) { return { id: f.getId(), name: f.getName() }; })),
    '素材名': g.files.map(function (f) { return f.getName(); }).join('、'),
    '作成日時': now_(), '更新日時': now_()
  });
  dispatch_('render', no);
  log_(no + ' の編集を開始（' + g.id + '・' + g.files.length + '本）');
}

// ---------------- 承認・修正・中止（LINEのコマンドから呼ばれる） ----------------

function videoByNumber_(n) {
  var all = rows_(CONFIG.SHEETS.VIDEOS);
  for (var i = 0; i < all.length; i++) {
    if (parseInt(String(all[i]['動画No']).replace(/\D/g, ''), 10) === n) return all[i];
  }
  return null;
}

function approveVideo_(n, when) {
  var v = videoByNumber_(n);
  if (!v) return '動画No.' + n + ' が見つかりません';
  if (v['状態'] !== '承認待ち') return v['動画No'] + ' は「' + v['状態'] + '」なので承認できません';
  var base = chooseBaseDay_(when);
  var files = JSON.parse(v['完成ファイル'] || '{}');
  var lines = [];
  CONFIG.SLOTS.forEach(function (s) {
    if (s.type.indexOf('threads') === 0 && !flag_('THREADS_AUTOPOST', false)) return;
    if (s.type === 'ig_story' && !files.story) return;
    var at;
    if (base.now && s.day === 0) {
      var lag = { ig_reel: 1, ig_story: 3, threads_video: 15 }[s.type] || 20;
      at = new Date(now_().getTime() + lag * 60000);
    } else {
      var time = (s.type === 'ig_reel' && base.reelTime) ? base.reelTime : s.time;
      at = atTime_(addDays_(base.now ? now_() : base.date, s.day), time);
    }
    var pid = nextId_(CONFIG.SHEETS.POSTS, '投稿ID', 'S');
    append_(CONFIG.SHEETS.POSTS, {
      '投稿ID': pid, '動画No': v['動画No'], '物件ID': v['物件ID'], '種類': s.type,
      '予定日時': at, '状態': '予約済み', '更新日時': now_()
    });
    lines.push(fmt_(at, 'M/d HH:mm') + ' ' + CONFIG.TYPE_LABEL[s.type]);
  });
  update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': '予約済み', '更新日時': now_() });
  var note = flag_('THREADS_AUTOPOST', false) ? '' : '\n（Threadsは自動投稿オフのため予約していません）';
  return '✅ ' + v['動画No'] + ' を予約しました\n' + lines.join('\n') + note;
}

/** 承認時の「11/2」「今すぐ」などの指定から、リールを出す日を決める。 */
function chooseBaseDay_(when) {
  if (/今すぐ|すぐ|now/i.test(when)) return { now: true };
  var m = String(when).match(/(\d{1,2})[\/月](\d{1,2})/);
  var t = String(when).match(/(\d{1,2}):(\d{2})/);
  if (m) {
    var y = jst_(now_()).y;
    var d = jstDate_(y, Number(m[1]) - 1, Number(m[2]), 12, 0);
    if (d.getTime() < now_().getTime() - 86400000) d = jstDate_(y + 1, Number(m[1]) - 1, Number(m[2]), 12, 0);
    return { date: d, reelTime: t ? t[1] + ':' + t[2] : '' };
  }
  // 空いている投稿日を探す（1日1リール）
  var taken = {};
  rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
    if (r['種類'] === 'ig_reel' && r['状態'] !== '取消' && r['予定日時'] instanceof Date) {
      taken[fmt_(r['予定日時'], 'yyyyMMdd')] = true;
    }
  });
  var d2 = new Date(now_());
  if (fmt_(d2, 'HH:mm') > CONFIG.SAME_DAY_CUTOFF) d2 = addDays_(d2, 1);
  for (var i = 0; i < 60; i++) {
    if (CONFIG.POST_DAYS.indexOf(jst_(d2).dow) >= 0 && !taken[fmt_(d2, 'yyyyMMdd')]) break;
    d2 = addDays_(d2, 1);
  }
  return { date: d2 };
}

// 日本時間で日付を扱う（スクリプトのタイムゾーン設定に左右されないように。日本に夏時間はない）
function jst_(d) {
  var x = new Date(d.getTime() + 9 * 3600000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay() };
}

function jstDate_(y, m, d, hh, mi) {
  return new Date(Date.UTC(y, m, d, (hh || 0) - 9, mi || 0));
}

function addDays_(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function atTime_(d, hhmm) {
  var p = hhmm.split(':');
  var j = jst_(d);
  return jstDate_(j.y, j.m, j.d, Number(p[0]), Number(p[1]));
}

function reviseVideo_(n, memo) {
  var v = videoByNumber_(n);
  if (!v) return '動画No.' + n + ' が見つかりません';
  if (['承認待ち', '失敗', '差し戻し'].indexOf(v['状態']) < 0) return v['動画No'] + ' は「' + v['状態'] + '」なので作り直せません';
  update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': '編集中', '修正メモ': memo, '更新日時': now_() });
  dispatch_('render', v['動画No']);
  return '🔁 ' + v['動画No'] + ' を作り直します。できたらまたお知らせします。' + (memo ? '\n指示: ' + memo : '');
}

function cancelVideo_(n) {
  var v = videoByNumber_(n);
  if (!v) return '動画No.' + n + ' が見つかりません';
  var c = 0;
  rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
    if (r['動画No'] === v['動画No'] && r['状態'] === '予約済み') {
      update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '取消', '更新日時': now_() });
      c++;
    }
  });
  update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': '承認待ち', '更新日時': now_() });
  return '⏹ ' + v['動画No'] + ' の予約を' + c + '件取り消しました（「OK ' + n + '」で再予約できます）';
}

function statusSummary_() {
  var wait = [], sched = [];
  rows_(CONFIG.SHEETS.VIDEOS).forEach(function (v) {
    if (v['状態'] === '承認待ち') wait.push(v['動画No'] + ' ' + v['物件ID'] + '：' + v['フック']);
  });
  rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
    if (r['状態'] === '予約済み' && r['予定日時'] instanceof Date) {
      sched.push(fmt_(r['予定日時'], 'M/d HH:mm') + ' ' + r['動画No'] + ' ' + CONFIG.TYPE_LABEL[r['種類']]);
    }
  });
  sched.sort();
  return '【承認待ち】\n' + (wait.join('\n') || 'なし') + '\n\n【予約】\n' + (sched.slice(0, 15).join('\n') || 'なし');
}

// ---------------- 2. 予約投稿 ----------------

function publishDue() {
  var due = rows_(CONFIG.SHEETS.POSTS).filter(function (r) {
    return r['状態'] === '予約済み' && r['予定日時'] instanceof Date && r['予定日時'].getTime() <= now_().getTime();
  });
  if (!due.length) return;
  var videos = {};
  rows_(CONFIG.SHEETS.VIDEOS).forEach(function (v) { videos[v['動画No']] = v; });
  var viaGithub = [];
  due.forEach(function (r) {
    var v = videos[r['動画No']];
    var prow = findRow_(CONFIG.SHEETS.PROPS, '物件ID', r['物件ID']);
    if (prow && String(prow['募集状況']) === '成約') {
      update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '取消', 'エラー': '成約のため取消', '更新日時': now_() });
      return;
    }
    if (r['種類'] === 'threads_text') {
      try {
        var out = threadsPostText_(String(v['Threadsコツ']), prop_('THREADS_TOPIC') || '');
        update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '投稿済み', 'SNSの投稿ID': out.media_id, 'URL': out.permalink, '更新日時': now_() });
      } catch (e) {
        update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '失敗', 'エラー': String(e).slice(0, 300), '更新日時': now_() });
        notifyOwner_('⚠ Threads文章の投稿に失敗（' + r['動画No'] + '）\n' + e);
      }
      return;
    }
    viaGithub.push(r);
  });
  if (!viaGithub.length) return;
  var job = 'J' + fmt_(now_(), 'yyMMddHHmmss');
  setProp_('JOB_' + job, JSON.stringify(viaGithub.map(function (r) { return r['投稿ID']; })));
  viaGithub.forEach(function (r) {
    update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '投稿中', 'ジョブ': job, '更新日時': now_() });
  });
  dispatch_('publish', job);
}

// ---------------- 3. 成約 ----------------

function syncSold() {
  rows_(CONFIG.SHEETS.PROPS).forEach(function (p) {
    if (String(p['募集状況']) === '成約' && !p['成約処理']) markSold_(String(p['物件ID']), true);
  });
}

function markSold_(id, fromSheet) {
  var p = findRow_(CONFIG.SHEETS.PROPS, '物件ID', id);
  if (!p) return '物件ID「' + id + '」が台帳にありません';
  update_(CONFIG.SHEETS.PROPS, p._row, { '募集状況': '成約', '成約処理': now_() });
  var cancelled = 0, deleted = 0, manual = [];
  rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
    if (String(r['物件ID']) !== id) return;
    if (r['状態'] === '予約済み') {
      update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '取消', 'エラー': '成約のため取消', '更新日時': now_() });
      cancelled++;
    } else if (r['状態'] === '投稿済み') {
      if (String(r['種類']).indexOf('threads') === 0 && r['SNSの投稿ID']) {
        try { threadsDelete_(r['SNSの投稿ID']); deleted++; update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '削除済み' }); }
        catch (e) { manual.push('Threads: ' + r['URL']); }
      } else if (r['種類'] !== 'ig_story' && r['URL']) {
        manual.push('Instagram: ' + r['URL']);
      }
    }
  });
  var msg = '🏠 ' + id + ' を成約にしました。予約' + cancelled + '件を取消、Threads' + deleted + '件を削除しました。';
  if (manual.length) {
    msg += '\n\nおとり広告にならないよう、次の投稿をアプリから「アーカイブ」するか、説明文を「成約済み」に編集してください：\n' + manual.join('\n');
  }
  if (fromSheet) notifyOwner_(msg);
  return msg;
}

// ---------------- 4. 見張り ----------------

function watchdog() {
  var limit = now_().getTime() - CONFIG.STUCK_MINUTES * 60000;
  rows_(CONFIG.SHEETS.VIDEOS).forEach(function (v) {
    if (v['状態'] === '編集中' && v['更新日時'] instanceof Date && v['更新日時'].getTime() < limit) {
      update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': '失敗', '注意': '編集が時間内に終わりませんでした', '更新日時': now_() });
      notifyOwner_('⚠ ' + v['動画No'] + ' の編集が終わりませんでした。GitHub の Actions 画面でエラーを確認してください。\n「修正 ' +
        parseInt(String(v['動画No']).replace(/\D/g, ''), 10) + '」でやり直せます。');
    }
  });
  rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
    if (r['状態'] === '投稿中' && r['更新日時'] instanceof Date && r['更新日時'].getTime() < limit) {
      update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '失敗', 'エラー': '投稿が時間内に終わりませんでした', '更新日時': now_() });
      notifyOwner_('⚠ ' + r['動画No'] + ' の' + CONFIG.TYPE_LABEL[r['種類']] + 'が投稿できませんでした。');
    }
  });
}
