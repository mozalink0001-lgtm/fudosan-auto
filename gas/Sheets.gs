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
