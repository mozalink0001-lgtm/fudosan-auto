/**
 * 不動産SNS自動投稿 — Apps Script 用の1ファイル版（tools/build_gas.sh で gas/ から生成）
 * Apps Script の「コード.gs」の中身をすべて消して、このファイルの内容を貼り付けてください。
 */

// ===================== Config.gs =====================

/**
 * 設定値。投稿時刻や曜日はここで変えられます。
 * 秘密の値（トークンなど）はコードに書かず、メニュー「自動投稿 > 設定画面」から保存します。
 */
var CONFIG = {
  TZ: 'Asia/Tokyo',

  // 承認した動画1本から作る投稿と、その投稿時刻（day: 0=リール当日, 1=翌日）
  SLOTS: [
    { type: 'ig_reel',       day: 0, time: '19:00' },
    { type: 'ig_story',      day: 0, time: '19:05' },
    { type: 'threads_video', day: 0, time: '20:30' },
    { type: 'ig_carousel',   day: 1, time: '12:15' },
    { type: 'threads_text',  day: 1, time: '07:40' }
  ],
  // リールを出す曜日（0=日 … 6=土）。1日1本まで
  POST_DAYS: [1, 2, 3, 4, 5, 6],
  // この時刻を過ぎて承認したら翌日以降に回す
  SAME_DAY_CUTOFF: '17:30',

  // 新着動画は最後の更新からこの分数たってから処理（アップロード途中を拾わないため）
  SETTLE_MINUTES: 4,
  // 編集・投稿がこの分数を超えて終わらなければ失敗扱い
  STUCK_MINUTES: 90,

  IG_API_VERSION: 'v25.0',
  IG_HOST: 'graph.instagram.com',

  SHEETS: {
    PROPS: '物件台帳',
    VIDEOS: '動画',
    POSTS: '投稿予定',
    REPLIES: 'LINE応答',
    FRIENDS: '友だち',
    LOG: 'ログ'
  },

  HEADERS: {
    '物件台帳': ['物件ID', '物件名', '種別', '賃料・価格(円)', '管理費等(円)', '間取り', '専有面積(㎡)', '最寄駅',
               '駅からの距離(m)', '所在地', '築年月', '取引態様', 'おすすめポイント', '募集状況', '情報更新日',
               '編集モード', '成約処理'],
    '動画': ['動画No', '物件ID', '状態', '素材', '素材名', '完成フォルダ', '完成ファイル', 'フック', 'リール本文',
            'カルーセル本文', 'Threads動画文', 'Threadsコツ', '注意', '修正メモ', '編集情報', '作成日時', '更新日時'],
    '投稿予定': ['投稿ID', '動画No', '物件ID', '種類', '予定日時', '状態', 'SNSの投稿ID', 'URL', 'エラー', 'ジョブ', '更新日時'],
    'LINE応答': ['キーワード', '返信'],
    '友だち': ['userId', '登録日', '種別', 'エリア', '予算', '間取り', '回答状況', '最終メッセージ'],
    'ログ': ['日時', '内容']
  },

  TYPE_LABEL: {
    ig_reel: 'IGリール', ig_story: 'IGストーリーズ', ig_carousel: 'IGカルーセル',
    threads_video: 'Threads動画', threads_text: 'Threads文章'
  }
};

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function flag_(key, defaultValue) {
  var v = prop_(key);
  if (v === '') return defaultValue;
  return v === 'true';
}

function now_() {
  return new Date();
}

function fmt_(date, pattern) {
  return Utilities.formatDate(date, CONFIG.TZ, pattern || 'yyyy/MM/dd HH:mm');
}

function randomKey_(len) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var s = '';
  for (var i = 0; i < (len || 32); i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function webAppUrl_() {
  return prop_('WEBAPP_URL') || (ScriptApp.getService().getUrl() || '');
}

function log_(msg) {
  try {
    sheet_(CONFIG.SHEETS.LOG).appendRow([now_(), String(msg).slice(0, 1000)]);
  } catch (e) {
    console.log(msg);
  }
}

// ===================== Sheets.gs =====================

/** スプレッドシートを「見出し名で読み書きする表」として扱う小さな道具。 */

function book_() {
  var id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function sheet_(name) {
  var sh = book_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。メニューの初期設定を実行してください。');
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

/** 全行を {見出し: 値, _row: 行番号} の配列で返す。 */
function rows_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var head = headers_(sh);
  var values = sh.getRange(2, 1, last - 1, head.length).getValues();
  return values.map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function findRow_(name, key, value) {
  var all = rows_(name);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i][key]) === String(value)) return all[i];
  }
  return null;
}

/** 指定した行の一部の列だけ書き換える。 */
function update_(name, rowNum, obj) {
  var sh = sheet_(name);
  var head = headers_(sh);
  Object.keys(obj).forEach(function (k) {
    var col = head.indexOf(k);
    if (col >= 0) sh.getRange(rowNum, col + 1).setValue(obj[k]);
  });
}

function append_(name, obj) {
  var sh = sheet_(name);
  var head = headers_(sh);
  sh.appendRow(head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
  return sh.getLastRow();
}

function nextId_(name, key, prefix) {
  var max = 0;
  rows_(name).forEach(function (r) {
    var n = parseInt(String(r[key]).replace(/\D/g, ''), 10);
    if (n > max) max = n;
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

/** 物件台帳の1行を、動画編集プログラムが読む形に変える。 */
function propertyForJob_(row) {
  function d(v, p) { return (v instanceof Date) ? fmt_(v, p) : String(v || ''); }
  return {
    id: String(row['物件ID']),
    name: String(row['物件名'] || ''),
    kind: String(row['種別'] || ''),
    price: row['賃料・価格(円)'],
    admin_fee: row['管理費等(円)'],
    layout: String(row['間取り'] || ''),
    area_m2: row['専有面積(㎡)'],
    station: String(row['最寄駅'] || ''),
    station_m: row['駅からの距離(m)'],
    address: String(row['所在地'] || ''),
    built: d(row['築年月'], 'yyyy年M月'),
    deal_type: String(row['取引態様'] || ''),
    points: String(row['おすすめポイント'] || ''),
    status: String(row['募集状況'] || ''),
    updated: row['情報更新日'] ? d(row['情報更新日'], 'yyyy年M月d日') : fmt_(now_(), 'yyyy年M月d日'),
    mode: String(row['編集モード'] || '自動')
  };
}

// ===================== Social.gs =====================

/** GitHub・Instagram・Threads との通信。 */

// ---------------- GitHub ----------------

function dispatch_(eventType, jobId) {
  var repo = prop_('GH_REPO');
  var token = prop_('GH_TOKEN');
  if (!repo || !token) throw new Error('GitHub の設定（リポジトリ名・トークン）がありません');
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: eventType, client_payload: { job_id: jobId } }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub の起動に失敗 (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
}

// ---------------- 共通 ----------------

function fetchJson_(url, options) {
  var opt = options || {};
  opt.muteHttpExceptions = true;
  var res = UrlFetchApp.fetch(url, opt);
  var text = res.getContentText();
  var body;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (res.getResponseCode() >= 400) {
    var msg = (body.error && (body.error.message || body.error_message)) || body.error_message || text;
    throw new Error(String(msg).slice(0, 300));
  }
  return body;
}

function qs_(obj) {
  return Object.keys(obj).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
  }).join('&');
}

// ---------------- Instagram（Instagram ログイン方式） ----------------

function igAuthUrl_() {
  var state = 'ig:' + oauthNonce_();
  return 'https://www.instagram.com/oauth/authorize?' + qs_({
    client_id: prop_('IG_APP_ID'),
    redirect_uri: webAppUrl_(),
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_content_publish',
    state: state
  });
}

function igExchange_(code) {
  var short = fetchJson_('https://api.instagram.com/oauth/access_token', {
    method: 'post',
    payload: {
      client_id: prop_('IG_APP_ID'), client_secret: prop_('IG_APP_SECRET'),
      grant_type: 'authorization_code', redirect_uri: webAppUrl_(), code: code.replace(/#_$/, '')
    }
  });
  var shortToken = short.access_token || (short.data && short.data[0].access_token);
  var long = fetchJson_('https://graph.instagram.com/access_token?' + qs_({
    grant_type: 'ig_exchange_token', client_secret: prop_('IG_APP_SECRET'), access_token: shortToken
  }));
  saveIgToken_(long.access_token, long.expires_in);
}

/** トークンを保存し、投稿に使うアカウントIDを取得する（手で貼ったトークンにも使う）。 */
function saveIgToken_(token, expiresIn) {
  var me = fetchJson_('https://' + CONFIG.IG_HOST + '/' + CONFIG.IG_API_VERSION + '/me?' + qs_({
    fields: 'user_id,username', access_token: token
  }));
  setProp_('IG_TOKEN', token);
  setProp_('IG_USER_ID', me.user_id || me.id);
  setProp_('IG_USERNAME', me.username || '');
  setProp_('IG_TOKEN_EXPIRES', now_().getTime() + (Number(expiresIn) || 60 * 86400) * 1000);
  log_('Instagram を連携しました: @' + (me.username || ''));
}

function refreshIg_() {
  var tok = prop_('IG_TOKEN');
  if (!tok) return;
  var r = fetchJson_('https://graph.instagram.com/refresh_access_token?' + qs_({
    grant_type: 'ig_refresh_token', access_token: tok
  }));
  setProp_('IG_TOKEN', r.access_token);
  setProp_('IG_TOKEN_EXPIRES', now_().getTime() + Number(r.expires_in || 60 * 86400) * 1000);
}

// ---------------- Threads ----------------

function threadsAuthUrl_() {
  return 'https://threads.net/oauth/authorize?' + qs_({
    client_id: prop_('THREADS_APP_ID'),
    redirect_uri: webAppUrl_(),
    scope: prop_('THREADS_SCOPES') || 'threads_basic,threads_content_publish',
    response_type: 'code',
    state: 'th:' + oauthNonce_()
  });
}

function threadsExchange_(code) {
  var short = fetchJson_('https://graph.threads.net/oauth/access_token', {
    method: 'post',
    payload: {
      client_id: prop_('THREADS_APP_ID'), client_secret: prop_('THREADS_APP_SECRET'),
      grant_type: 'authorization_code', redirect_uri: webAppUrl_(), code: code.replace(/#_$/, '')
    }
  });
  var long = fetchJson_('https://graph.threads.net/access_token?' + qs_({
    grant_type: 'th_exchange_token', client_secret: prop_('THREADS_APP_SECRET'), access_token: short.access_token
  }));
  saveThreadsToken_(long.access_token, long.expires_in);
}

function saveThreadsToken_(token, expiresIn) {
  var me = fetchJson_('https://graph.threads.net/v1.0/me?' + qs_({ fields: 'id,username', access_token: token }));
  setProp_('THREADS_TOKEN', token);
  setProp_('THREADS_USER_ID', me.id);
  setProp_('THREADS_USERNAME', me.username || '');
  setProp_('THREADS_TOKEN_EXPIRES', now_().getTime() + (Number(expiresIn) || 60 * 86400) * 1000);
  log_('Threads を連携しました: @' + (me.username || ''));
}

function refreshThreads_() {
  var tok = prop_('THREADS_TOKEN');
  if (!tok) return;
  var r = fetchJson_('https://graph.threads.net/refresh_access_token?' + qs_({
    grant_type: 'th_refresh_token', access_token: tok
  }));
  setProp_('THREADS_TOKEN', r.access_token);
  setProp_('THREADS_TOKEN_EXPIRES', now_().getTime() + Number(r.expires_in || 60 * 86400) * 1000);
}

/** 文章だけの Threads 投稿は GitHub を通さずここで出す。 */
function threadsPostText_(text, topic) {
  var uid = prop_('THREADS_USER_ID');
  var tok = prop_('THREADS_TOKEN');
  var base = 'https://graph.threads.net/v1.0/';
  var payload = { media_type: 'TEXT', text: text, access_token: tok };
  if (topic) payload.topic_tag = topic;
  var c;
  try {
    c = fetchJson_(base + uid + '/threads', { method: 'post', payload: payload });
  } catch (e) {
    if (!topic || String(e).toLowerCase().indexOf('topic') < 0) throw e;
    delete payload.topic_tag;
    c = fetchJson_(base + uid + '/threads', { method: 'post', payload: payload });
  }
  Utilities.sleep(4000);
  var p = fetchJson_(base + uid + '/threads_publish', { method: 'post', payload: { creation_id: c.id, access_token: tok } });
  var link = '';
  try {
    link = fetchJson_(base + p.id + '?' + qs_({ fields: 'permalink', access_token: tok })).permalink || '';
  } catch (e) { /* URL が取れなくても投稿は成功 */ }
  return { media_id: p.id, permalink: link };
}

function threadsDelete_(mediaId) {
  fetchJson_('https://graph.threads.net/v1.0/' + mediaId + '?' + qs_({ access_token: prop_('THREADS_TOKEN') }),
    { method: 'delete' });
}

/** トークンの期限が近ければ延長する（毎日実行）。 */
function refreshTokens() {
  var soon = now_().getTime() + 20 * 86400 * 1000;
  [['IG_TOKEN_EXPIRES', refreshIg_, 'Instagram'], ['THREADS_TOKEN_EXPIRES', refreshThreads_, 'Threads']]
    .forEach(function (t) {
      var exp = Number(prop_(t[0]) || 0);
      if (exp && exp < soon) {
        try { t[1](); log_(t[2] + ' のトークンを延長しました'); }
        catch (e) { notifyOwner_('⚠ ' + t[2] + ' のトークン延長に失敗しました。設定画面から連携し直してください。\n' + e); }
      }
    });
}

function oauthNonce_() {
  var n = prop_('OAUTH_NONCE');
  if (!n) { n = randomKey_(16); setProp_('OAUTH_NONCE', n); }
  return n;
}

// ===================== Line.gs =====================

/**
 * 公式LINE。お客様への返事はすべて「応答メッセージ（返信）」で送るので、無料プランの通数を使いません。
 * 通数を使うのは、あなた（オーナー）への承認・エラー通知のプッシュだけです。
 */

var LINE_API = 'https://api.line.me/v2/bot/message/';

function lineSend_(path, body) {
  var tok = prop_('LINE_TOKEN');
  if (!tok) return;
  UrlFetchApp.fetch(LINE_API + path, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + tok },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
}

function reply_(token, messages) {
  lineSend_('reply', { replyToken: token, messages: [].concat(messages).slice(0, 5) });
}

function notifyOwner_(text) {
  var owner = prop_('OWNER_LINE_USER_ID');
  if (!owner) { log_('（LINE未登録のため通知できず）' + text); return; }
  lineSend_('push', { to: owner, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] });
}

function txt_(text, quick) {
  var m = { type: 'text', text: String(text).slice(0, 4900) };
  if (quick && quick.length) {
    m.quickReply = {
      items: quick.slice(0, 13).map(function (q) {
        return { type: 'action', action: { type: 'message', label: q.slice(0, 20), text: q } };
      })
    };
  }
  return m;
}

function handleLine_(body) {
  (body.events || []).forEach(function (ev) {
    try { handleLineEvent_(ev); } catch (e) { log_('LINE処理エラー: ' + e); }
  });
}

function handleLineEvent_(ev) {
  var uid = ev.source && ev.source.userId;
  if (!uid || !ev.replyToken) return;
  if (ev.type === 'follow') {
    startSurvey_(uid, ev.replyToken, true);
    return;
  }
  if (ev.type !== 'message' || ev.message.type !== 'text') return;
  var text = String(ev.message.text).trim();

  // オーナー登録: 設定画面に出る「登録 XXXXXX」を送る
  var reg = text.match(/^登録\s*([A-Za-z0-9]{6,})$/);
  if (reg && reg[1] === prop_('OWNER_CODE')) {
    setProp_('OWNER_LINE_USER_ID', uid);
    reply_(ev.replyToken, txt_('オーナーとして登録しました。承認の通知がこのトークに届きます。\n「ヘルプ」で使えるコマンドを表示します。'));
    return;
  }
  if (uid === prop_('OWNER_LINE_USER_ID') && ownerCommand_(text, ev.replyToken)) return;
  customerMessage_(uid, text, ev.replyToken);
}

// ---------------- お客様向け：条件アンケート ----------------

var SURVEY = {
  kind: { q: 'ご希望を教えてください', opts: ['賃貸を探す', '購入を検討'] },
  area: { q: '希望のエリアや駅名を送ってください（例：中野駅）' },
  budget: {
    q: 'ご予算はどのくらいですか？',
    rent: ['〜6万円', '6〜8万円', '8〜10万円', '10〜15万円', '15万円〜'],
    buy: ['〜3,000万円', '3,000〜5,000万円', '5,000〜8,000万円', '8,000万円〜']
  },
  layout: { q: '間取りのご希望は？', opts: ['1R・1K', '1LDK', '2LDK', '3LDK以上', 'こだわらない'] }
};

function friend_(uid) {
  var f = findRow_(CONFIG.SHEETS.FRIENDS, 'userId', uid);
  if (f) return f;
  var row = append_(CONFIG.SHEETS.FRIENDS, { userId: uid, '登録日': now_(), '回答状況': 'kind' });
  return findRow_(CONFIG.SHEETS.FRIENDS, 'userId', uid) || { _row: row, '回答状況': 'kind' };
}

function startSurvey_(uid, replyToken, greeting) {
  var f = friend_(uid);
  update_(CONFIG.SHEETS.FRIENDS, f._row, { '回答状況': 'kind', '最終メッセージ': now_() });
  var msgs = [];
  if (greeting) {
    msgs.push(txt_(prop_('LINE_GREETING') ||
      '友だち追加ありがとうございます！\nInstagramでご紹介している物件の間取り図や、初期費用の見積りをこちらでお送りしています。\nまずはご希望を3つだけ教えてください。'));
  }
  msgs.push(txt_(SURVEY.kind.q, SURVEY.kind.opts));
  reply_(replyToken, msgs);
}

function customerMessage_(uid, text, replyToken) {
  var f = friend_(uid);
  update_(CONFIG.SHEETS.FRIENDS, f._row, { '最終メッセージ': now_() });
  if (/^(条件を変更|リセット|最初から)$/.test(text)) return startSurvey_(uid, replyToken, false);

  var step = String(f['回答状況'] || '');
  if (step === 'kind' && SURVEY.kind.opts.indexOf(text) >= 0) {
    update_(CONFIG.SHEETS.FRIENDS, f._row, { '種別': text === '購入を検討' ? '売買' : '賃貸', '回答状況': 'area' });
    return reply_(replyToken, txt_(SURVEY.area.q));
  }
  if (step === 'area') {
    update_(CONFIG.SHEETS.FRIENDS, f._row, { 'エリア': text.slice(0, 50), '回答状況': 'budget' });
    var opts = String(f['種別']) === '売買' ? SURVEY.budget.buy : SURVEY.budget.rent;
    return reply_(replyToken, txt_(SURVEY.budget.q, opts));
  }
  if (step === 'budget') {
    update_(CONFIG.SHEETS.FRIENDS, f._row, { '予算': text.slice(0, 30), '回答状況': 'layout' });
    return reply_(replyToken, txt_(SURVEY.layout.q, SURVEY.layout.opts));
  }
  if (step === 'layout') {
    update_(CONFIG.SHEETS.FRIENDS, f._row, { '間取り': text.slice(0, 30), '回答状況': '完了' });
    var fr = findRow_(CONFIG.SHEETS.FRIENDS, 'userId', uid);
    return reply_(replyToken, matchListings_(fr));
  }

  // キーワード応答（シート「LINE応答」で編集できます）
  var replies = rows_(CONFIG.SHEETS.REPLIES);
  for (var i = 0; i < replies.length; i++) {
    var keys = String(replies[i]['キーワード']).split(/[、,]/);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j] && text.indexOf(keys[j].trim()) >= 0) {
        return reply_(replyToken, txt_(replies[i]['返信'], ['物件を探す', '条件を変更']));
      }
    }
  }
  if (/物件を探す|物件|おすすめ/.test(text)) return reply_(replyToken, matchListings_(f));
  reply_(replyToken, txt_('メッセージありがとうございます。担当者が確認して、こちらのトークでお返事します。',
    ['物件を探す', '初期費用', '内見予約', '条件を変更']));
}

function budgetRange_(label) {
  var nums = String(label).replace(/,/g, '').match(/\d+/g) || [];
  var unit = 10000;
  var lo = 0, hi = Infinity;
  if (/^〜/.test(label)) hi = Number(nums[0]) * unit;
  else if (/〜$/.test(label)) lo = Number(nums[0]) * unit;
  else if (nums.length >= 2) { lo = Number(nums[0]) * unit; hi = Number(nums[1]) * unit; }
  return [lo, hi * 1.05];
}

function layoutOk_(want, layout) {
  if (!want || want === 'こだわらない') return true;
  var l = String(layout).toUpperCase();
  if (want === '1R・1K') return /1R|1K/.test(l);
  if (want === '3LDK以上') return /^[3-9]/.test(l);
  return l.indexOf(want) === 0;
}

function matchListings_(f) {
  var kind = String(f['種別'] || '賃貸');
  var area = String(f['エリア'] || '').replace(/駅$/, '');
  var range = budgetRange_(f['予算'] || '');
  var posts = rows_(CONFIG.SHEETS.POSTS);
  var hits = rows_(CONFIG.SHEETS.PROPS).filter(function (p) {
    if (String(p['募集状況']) !== '募集中') return false;
    if (String(p['種別'] || '賃貸').charAt(0) !== kind.charAt(0)) return false;
    var price = Number(p['賃料・価格(円)']) || 0;
    if (price && (price < range[0] || price > range[1])) return false;
    if (!layoutOk_(f['間取り'], p['間取り'])) return false;
    if (area && (String(p['最寄駅']) + String(p['所在地'])).indexOf(area) < 0) return false;
    return true;
  }).slice(0, 3);
  if (!hits.length) {
    notifyOwner_('🔔 新しいお客様（条件に合う物件なし）\n' + [kind, f['エリア'], f['予算'], f['間取り']].join(' / '));
    return txt_('ありがとうございます！今ご紹介できる物件を担当者が確認して、こちらでご連絡します。', ['条件を変更']);
  }
  var lines = hits.map(function (p) {
    var link = '';
    posts.forEach(function (q) {
      if (String(q['物件ID']) === String(p['物件ID']) && q['種類'] === 'ig_reel' && q['URL']) link = q['URL'];
    });
    var pp = propertyForJob_(p);
    return '■ ' + (pp.name || pp.id) + '\n' + [yenShort_(pp.price), pp.layout, pp.station + (walkMin_(pp.station_m) ? ' 徒歩' + walkMin_(pp.station_m) + '分' : '')]
      .filter(String).join('｜') + (link ? '\n動画: ' + link : '');
  });
  return [
    txt_('ご希望に合いそうな物件です。\n\n' + lines.join('\n\n')),
    txt_('間取り図・初期費用の見積り・内見のご予約は、このトークに「物件名」と送ってください。', ['内見予約', '初期費用', '条件を変更'])
  ];
}

function walkMin_(m) {
  var n = Number(m);
  return n > 0 ? Math.max(1, Math.ceil(n / 80)) : 0;
}

function yenShort_(v) {
  var n = Number(String(v).replace(/[,円]/g, ''));
  if (!n) return String(v || '');
  if (n >= 10000) {
    var man = n / 10000;
    return (man >= 100 ? Math.round(man).toLocaleString() : String(Math.round(man * 100) / 100)) + '万円';
  }
  return n.toLocaleString() + '円';
}

// ---------------- オーナー向けコマンド ----------------

var OWNER_HELP = [
  '使えるコマンド',
  'OK 3 … 動画No.3を承認（空いている日の19時から予約）',
  'OK 3 11/2 … 11月2日に予約',
  'OK 3 今すぐ … すぐ投稿',
  '修正 3 冒頭を家賃からにして … 指示を付けて作り直し',
  '中止 3 … 予約を取り消し',
  '成約 P001 … 成約にして関連する投稿を整理',
  '一覧 … 承認待ちと予約の一覧'
].join('\n');

function ownerCommand_(text, replyToken) {
  var t = text.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ');
  var m;
  if (/^(ヘルプ|help)$/i.test(t)) { reply_(replyToken, txt_(OWNER_HELP)); return true; }
  if (/^一覧$/.test(t)) { reply_(replyToken, txt_(statusSummary_())); return true; }
  if ((m = t.match(/^(?:ok|ＯＫ|承認)\s*(\d+)\s*(.*)$/i))) {
    reply_(replyToken, txt_(approveVideo_(Number(m[1]), m[2].trim())));
    return true;
  }
  if ((m = t.match(/^修正\s*(\d+)\s*([\s\S]*)$/))) {
    reply_(replyToken, txt_(reviseVideo_(Number(m[1]), m[2].trim())));
    return true;
  }
  if ((m = t.match(/^中止\s*(\d+)$/))) {
    reply_(replyToken, txt_(cancelVideo_(Number(m[1]))));
    return true;
  }
  if ((m = t.match(/^成約\s*(\S+)$/))) {
    reply_(replyToken, txt_(markSold_(m[1])));
    return true;
  }
  return false;
}

// ===================== Main.gs =====================

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

// ===================== WebApp.gs =====================

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

// ===================== Setup.gs =====================

/** メニュー・初期設定・設定画面・状態チェック。 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('自動投稿')
    .addItem('① 初期設定（シートとフォルダを作る）', 'setupAll')
    .addItem('② 設定画面を開く', 'openSettings')
    .addItem('③ 自動実行をオンにする', 'installTriggers')
    .addSeparator()
    .addItem('今すぐ新着動画を確認', 'tick')
    .addItem('状態チェック', 'showCheck')
    .addItem('自動実行をオフにする', 'removeTriggers')
    .addToUi();
}

function setupAll() {
  var ss = SpreadsheetApp.getActive();
  setProp_('SPREADSHEET_ID', ss.getId());
  Object.keys(CONFIG.HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      var head = CONFIG.HEADERS[name];
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e3efea');
      sh.setFrozenRows(1);
    }
  });
  var props = sheet_(CONFIG.SHEETS.PROPS);
  if (props.getLastRow() === 1) {
    append_(CONFIG.SHEETS.PROPS, {
      '物件ID': 'P001', '物件名': 'サンプルマンション', '種別': '賃貸', '賃料・価格(円)': 78000, '管理費等(円)': 5000,
      '間取り': '1LDK', '専有面積(㎡)': 40.5, '最寄駅': '中野駅', '駅からの距離(m)': 640, '所在地': '東京都中野区○○',
      '築年月': '2016年3月', '取引態様': '仲介', 'おすすめポイント': '南向きLDK12帖、2口コンロ、独立洗面台、宅配ボックス',
      '募集状況': '募集中', '情報更新日': now_(), '編集モード': '自動'
    });
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(['募集中', '申込あり', '成約'], true).build();
    props.getRange(2, CONFIG.HEADERS['物件台帳'].indexOf('募集状況') + 1, 500, 1).setDataValidation(rule);
    var rule2 = SpreadsheetApp.newDataValidation().requireValueInList(['自動', 'ツアー', 'トーク'], true).build();
    props.getRange(2, CONFIG.HEADERS['物件台帳'].indexOf('編集モード') + 1, 500, 1).setDataValidation(rule2);
  }
  var rep = sheet_(CONFIG.SHEETS.REPLIES);
  if (rep.getLastRow() === 1) {
    [['初期費用', '初期費用は、敷金・礼金・仲介手数料・前家賃・火災保険・保証料などの合計です。気になる物件名を送っていただければ、お見積りをお送りします。'],
     ['内見,内覧,見学', '内見のご予約ありがとうございます。ご希望の物件名と、ご都合のよい日時を2〜3候補送ってください。'],
     ['営業時間,定休日', '営業時間は10:00〜19:00、定休日は水曜日です。（ここはシート「LINE応答」で書き換えてください）']]
      .forEach(function (r) { rep.appendRow(r); });
  }

  // ドライブのフォルダ
  if (!prop_('FOLDER_ROOT')) {
    var root = DriveApp.createFolder('SNS自動投稿');
    setProp_('FOLDER_ROOT', root.getId());
    setProp_('FOLDER_INBOX', root.createFolder('01_投稿待ち（ここに動画を入れる）').getId());
    setProp_('FOLDER_SOURCE', root.createFolder('02_素材保管').getId());
    setProp_('FOLDER_OUTPUT', root.createFolder('03_完成').getId());
  }
  // 合言葉
  if (!prop_('GAS_SECRET')) setProp_('GAS_SECRET', randomKey_(40));
  if (!prop_('LINE_WEBHOOK_KEY')) setProp_('LINE_WEBHOOK_KEY', randomKey_(24));
  if (!prop_('OWNER_CODE')) setProp_('OWNER_CODE', randomKey_(8));
  if (!prop_('THREADS_TOPIC')) setProp_('THREADS_TOPIC', '部屋探し');

  SpreadsheetApp.getUi().alert('初期設定が終わりました。\n\nGoogleドライブに「SNS自動投稿」フォルダを作りました。\n' +
    '次に、手順書のとおりウェブアプリとしてデプロイしてから「② 設定画面を開く」に進んでください。');
}

function openSettings() {
  var html = HtmlService.createHtmlOutputFromFile('Settings').setWidth(640).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, '自動投稿の設定');
}

/** 設定画面に表示する値。保存済みの秘密の値そのものは返さない。 */
function getSettings() {
  var url = webAppUrl_();
  var has = function (k) { return prop_(k) ? '保存済み' : ''; };
  return {
    webapp_url: url,
    webapp_url_saved: prop_('WEBAPP_URL'),
    gas_secret: prop_('GAS_SECRET'),
    line_webhook: url ? url + '?line=' + prop_('LINE_WEBHOOK_KEY') : '',
    owner_code: '登録 ' + prop_('OWNER_CODE'),
    owner_set: !!prop_('OWNER_LINE_USER_ID'),
    GH_REPO: prop_('GH_REPO'), GH_TOKEN: has('GH_TOKEN'),
    LINE_TOKEN: has('LINE_TOKEN'), LINE_GREETING: prop_('LINE_GREETING'),
    IG_APP_ID: prop_('IG_APP_ID'), IG_APP_SECRET: has('IG_APP_SECRET'),
    IG_USERNAME: prop_('IG_USERNAME'),
    THREADS_APP_ID: prop_('THREADS_APP_ID'), THREADS_APP_SECRET: has('THREADS_APP_SECRET'),
    THREADS_USERNAME: prop_('THREADS_USERNAME'),
    THREADS_AUTOPOST: flag_('THREADS_AUTOPOST', false),
    THREADS_DELETE: /threads_delete/.test(prop_('THREADS_SCOPES')),
    THREADS_TOPIC: prop_('THREADS_TOPIC'),
    ig_auth: prop_('IG_APP_ID') && url ? igAuthUrl_() : '',
    threads_auth: prop_('THREADS_APP_ID') && url ? threadsAuthUrl_() : ''
  };
}

function saveSettings(form) {
  var keys = ['WEBAPP_URL', 'GH_REPO', 'GH_TOKEN', 'LINE_TOKEN', 'LINE_GREETING', 'IG_APP_ID', 'IG_APP_SECRET',
    'THREADS_APP_ID', 'THREADS_APP_SECRET', 'THREADS_TOPIC'];
  keys.forEach(function (k) {
    var v = form[k];
    if (v === undefined || v === null) return;
    v = String(v).trim();
    if (v === '' || v === '保存済み') return;   // 空欄は「変更しない」
    setProp_(k, v);
  });
  setProp_('THREADS_AUTOPOST', form.THREADS_AUTOPOST ? 'true' : 'false');
  setProp_('THREADS_SCOPES', 'threads_basic,threads_content_publish' + (form.THREADS_DELETE ? ',threads_delete' : ''));
  var msgs = ['保存しました'];
  if (form.IG_TOKEN_MANUAL) { saveIgToken_(String(form.IG_TOKEN_MANUAL).trim(), 60 * 86400); msgs.push('Instagram のトークンを保存'); }
  if (form.THREADS_TOKEN_MANUAL) { saveThreadsToken_(String(form.THREADS_TOKEN_MANUAL).trim(), 60 * 86400); msgs.push('Threads のトークンを保存'); }
  return msgs.join('・');
}

function installTriggers() {
  removeTriggers(true);
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('refreshTokens').timeBased().everyDays(1).atHour(4).create();
  SpreadsheetApp.getUi().alert('自動実行をオンにしました（10分ごとに新着と予約を確認します）。');
}

function removeTriggers(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (silent !== true) SpreadsheetApp.getUi().alert('自動実行をオフにしました。');
}

/** 設定がそろっているかを確認する。 */
function selfCheck() {
  var r = [];
  function ok(label, cond, hint) { r.push((cond ? '✅ ' : '❌ ') + label + (cond || !hint ? '' : '：' + hint)); }
  ok('シート', !!book_().getSheetByName(CONFIG.SHEETS.VIDEOS), 'メニュー①を実行');
  ok('ドライブのフォルダ', !!prop_('FOLDER_INBOX'), 'メニュー①を実行');
  ok('ウェブアプリURL', !!webAppUrl_(), 'デプロイ → ウェブアプリ を実行し、URLを設定画面に貼る');
  var gh = false;
  if (prop_('GH_REPO') && prop_('GH_TOKEN')) {
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GH_REPO'), {
      headers: { Authorization: 'Bearer ' + prop_('GH_TOKEN') }, muteHttpExceptions: true });
    gh = res.getResponseCode() === 200;
  }
  ok('GitHub', gh, 'リポジトリ名（ユーザー名/リポジトリ名）とトークンを確認');
  var line = false;
  if (prop_('LINE_TOKEN')) {
    var lr = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: 'Bearer ' + prop_('LINE_TOKEN') }, muteHttpExceptions: true });
    line = lr.getResponseCode() === 200;
  }
  ok('LINE', line, 'チャネルアクセストークン（長期）を確認');
  ok('LINEのオーナー登録', !!prop_('OWNER_LINE_USER_ID'), '公式LINEに「' + '登録 ' + prop_('OWNER_CODE') + '」と送る');
  ok('Instagram 連携', !!prop_('IG_TOKEN'), '設定画面から連携');
  ok('Threads 連携', !!prop_('THREADS_TOKEN'), '設定画面から連携（ならし運用中は後回しでOK）');
  ok('自動実行', ScriptApp.getProjectTriggers().length > 0, 'メニュー③を実行');
  return r.join('\n');
}

function showCheck() {
  SpreadsheetApp.getUi().alert(selfCheck());
}
