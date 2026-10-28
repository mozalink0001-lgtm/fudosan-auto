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
