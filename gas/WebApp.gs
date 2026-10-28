/**
 * ウェブアプリの入口。
 *  - LINE の Webhook（URL に ?line=合言葉 が付いたもの）
 *  - GitHub Actions からの問い合わせ・報告（本文に合言葉 key）
 *  - Instagram / Threads の連携（OAuth のリダイレクト先）
 * GAS のウェブアプリはリクエストヘッダーを読めないため、LINE の署名検証の代わりに URL の合言葉で確認します。
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.code && p.state) {
    var parts = String(p.state).split(':');
    var html;
    try {
      if (parts[1] !== prop_('OAUTH_NONCE')) throw new Error('連携リンクが古いか、正しくありません。設定画面から開き直してください。');
      if (parts[0] === 'ig') igExchange_(p.code);
      else if (parts[0] === 'th') threadsExchange_(p.code);
      else throw new Error('不明な連携です');
      html = '<h2>連携しました</h2><p>このページを閉じて、スプレッドシートの設定画面で「状態チェック」を押してください。</p>';
    } catch (err) {
      html = '<h2>連携できませんでした</h2><p>' + String(err).replace(/[<>&]/g, '') + '</p>';
    }
    return HtmlService.createHtmlOutput('<div style="font-family:sans-serif;padding:24px">' + html + '</div>');
  }
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">稼働中</p>');
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }

  if (p.line) {
    if (p.line === prop_('LINE_WEBHOOK_KEY')) handleLine_(body);
    return json_({ ok: true });
  }
  if (!body.key || body.key !== prop_('GAS_SECRET')) return json_({ ok: false, error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var fn = API[body.action];
    if (!fn) return json_({ ok: false, error: 'unknown action' });
    var out = fn(body) || {};
    out.ok = true;
    return json_(out);
  } catch (err) {
    log_('API ' + body.action + ' エラー: ' + err);
    return json_({ ok: false, error: String(err).slice(0, 300) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var API = {
  get_render_job: function (b) {
    var v = findRow_(CONFIG.SHEETS.VIDEOS, '動画No', b.job_id);
    if (!v) throw new Error('動画が見つかりません: ' + b.job_id);
    var prow = findRow_(CONFIG.SHEETS.PROPS, '物件ID', v['物件ID']);
    if (!prow) throw new Error('物件が見つかりません: ' + v['物件ID']);
    update_(CONFIG.SHEETS.VIDEOS, v._row, { '更新日時': now_() });
    return {
      drive_token: ScriptApp.getOAuthToken(),
      files: JSON.parse(v['素材'] || '[]'),
      property: propertyForJob_(prow),
      memo: String(v['修正メモ'] || ''),
      output_parent_id: prop_('FOLDER_OUTPUT')
    };
  },

  render_done: function (b) {
    var v = findRow_(CONFIG.SHEETS.VIDEOS, '動画No', b.job_id);
    var t = b.texts || {};
    update_(CONFIG.SHEETS.VIDEOS, v._row, {
      '状態': '承認待ち', '完成フォルダ': b.folder_id, '完成ファイル': JSON.stringify(b.files),
      'フック': t.hook || '', 'リール本文': t.reel_caption || '', 'カルーセル本文': t.carousel_caption || '',
      'Threads動画文': t.threads_video || '', 'Threadsコツ': t.threads_tip || '',
      '注意': (b.warnings || []).join(' / '), '編集情報': JSON.stringify(b.meta || {}), '更新日時': now_()
    });
    var n = parseInt(String(b.job_id).replace(/\D/g, ''), 10);
    var m = b.meta || {};
    var msg = '🎬 ' + b.job_id + '（' + v['物件ID'] + '）ができました\n' +
      'リール ' + (m.reel_seconds || '?') + '秒・写真' + (m.photos || 0) + '枚・' + (m.mode === 'talk' ? 'トーク編集' : 'ツアー編集') + '\n' +
      '確認: https://drive.google.com/drive/folders/' + b.folder_id + '\n\n' +
      '― リール本文 ―\n' + String(t.reel_caption || '').slice(0, 600) + '\n\n' +
      ((b.warnings || []).length ? '⚠ ' + b.warnings.join('\n⚠ ') + '\n\n' : '') +
      '「OK ' + n + '」で予約 / 「修正 ' + n + ' 指示」で作り直し\n文章はスプレッドシート「動画」シートで直接直せます';
    notifyOwner_(msg);
    return {};
  },

  render_failed: function (b) {
    var v = findRow_(CONFIG.SHEETS.VIDEOS, '動画No', b.job_id);
    if (v) update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': '失敗', '注意': b.error, '更新日時': now_() });
    notifyOwner_('⚠ ' + b.job_id + ' の編集に失敗しました\n' + b.error + '\n「修正 ' +
      parseInt(String(b.job_id).replace(/\D/g, ''), 10) + '」でやり直せます');
    return {};
  },

  get_publish_job: function (b) {
    var ids = JSON.parse(prop_('JOB_' + b.job_id) || '[]');
    var videos = {};
    rows_(CONFIG.SHEETS.VIDEOS).forEach(function (v) { videos[v['動画No']] = v; });
    var posts = rows_(CONFIG.SHEETS.POSTS).filter(function (r) { return ids.indexOf(r['投稿ID']) >= 0; })
      .map(function (r) {
        var v = videos[r['動画No']];
        var files = JSON.parse(v['完成ファイル'] || '{}');
        var type = r['種類'];
        var fileIds = type === 'ig_carousel' ? (files.carousel || [])
          : type === 'ig_story' ? [files.story] : [files.reel];
        var caption = type === 'ig_reel' ? v['リール本文']
          : type === 'ig_carousel' ? v['カルーセル本文']
          : type === 'threads_video' ? v['Threads動画文']
          : type === 'threads_text' ? v['Threadsコツ'] : '';
        return {
          post_id: r['投稿ID'], type: type, caption: String(caption || ''),
          topic: prop_('THREADS_TOPIC') || '',
          files: fileIds.filter(String).map(function (id, i) {
            return { id: id, name: (type === 'ig_carousel' || type === 'ig_story') ? i + '.jpg' : 'reel.mp4' };
          })
        };
      });
    var out = { job_id: b.job_id, drive_token: ScriptApp.getOAuthToken(), posts: posts };
    if (prop_('IG_TOKEN')) {
      out.ig = { user_id: prop_('IG_USER_ID'), token: prop_('IG_TOKEN'), version: CONFIG.IG_API_VERSION, host: CONFIG.IG_HOST };
    }
    if (prop_('THREADS_TOKEN')) out.threads = { user_id: prop_('THREADS_USER_ID'), token: prop_('THREADS_TOKEN') };
    return out;
  },

  publish_done: function (b) {
    var byId = {};
    (b.results || []).forEach(function (r) { byId[r.post_id] = r; });
    var fails = [], reels = [];
    rows_(CONFIG.SHEETS.POSTS).forEach(function (r) {
      var res = byId[r['投稿ID']];
      if (!res) return;
      if (res.ok) {
        update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '投稿済み', 'SNSの投稿ID': res.media_id, 'URL': res.permalink || '', 'エラー': '', '更新日時': now_() });
        if (r['種類'] === 'ig_reel') reels.push(r['動画No'] + ' ' + (res.permalink || ''));
      } else {
        update_(CONFIG.SHEETS.POSTS, r._row, { '状態': '失敗', 'エラー': res.error, '更新日時': now_() });
        fails.push(r['動画No'] + ' ' + CONFIG.TYPE_LABEL[r['種類']] + '：' + res.error);
      }
    });
    PropertiesService.getScriptProperties().deleteProperty('JOB_' + b.job_id);
    refreshVideoStates_();
    if (fails.length) notifyOwner_('⚠ 投稿に失敗したものがあります\n' + fails.join('\n'));
    if (reels.length && flag_('NOTIFY_SUCCESS', true)) notifyOwner_('📣 リールを投稿しました\n' + reels.join('\n'));
    return {};
  }
};

/** 予約がすべて終わった動画を「投稿済み」にする。 */
function refreshVideoStates_() {
  var posts = rows_(CONFIG.SHEETS.POSTS);
  rows_(CONFIG.SHEETS.VIDEOS).forEach(function (v) {
    if (v['状態'] !== '予約済み') return;
    var mine = posts.filter(function (p) { return p['動画No'] === v['動画No'] && p['状態'] !== '取消'; });
    if (!mine.length) return;
    var pending = mine.some(function (p) { return p['状態'] === '予約済み' || p['状態'] === '投稿中'; });
    if (pending) return;
    var failed = mine.some(function (p) { return p['状態'] === '失敗'; });
    update_(CONFIG.SHEETS.VIDEOS, v._row, { '状態': failed ? '一部失敗' : '投稿済み', '更新日時': now_() });
  });
}
