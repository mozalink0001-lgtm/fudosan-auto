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
  // 公開リポジトリは誰でも読めるので、実際に依頼（何も起動しない ping）を送れるかで確かめる
  var gh = false, ghHint = 'リポジトリ名（ユーザー名/リポジトリ名）とトークンを確認';
  if (prop_('GH_REPO') && prop_('GH_TOKEN')) {
    var res = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GH_REPO') + '/dispatches', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + prop_('GH_TOKEN'), Accept: 'application/vnd.github+json' },
      payload: JSON.stringify({ event_type: 'ping' }), muteHttpExceptions: true });
    gh = res.getResponseCode() === 204;
    if (res.getResponseCode() === 403) ghHint = 'トークンの権限が足りません（Contents を Read and write に）';
    if (res.getResponseCode() === 404) ghHint = 'リポジトリ名が違うか、トークンでこのリポジトリが選ばれていません';
    if (res.getResponseCode() === 401) ghHint = 'トークンが無効です（期限切れ・貼り間違い）';
  }
  ok('GitHub', gh, ghHint);
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
