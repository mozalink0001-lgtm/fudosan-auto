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
