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
