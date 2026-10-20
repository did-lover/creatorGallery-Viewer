/* =====================================================================
   dropbox.js — Dropbox の画像・動画を index.html のギャラリー形式で読み込む
   - DROPBOX_APP_KEY が空のときは何もしない（data.js / サンプルでそのまま動く）
   - 認証は OAuth 2.0 PKCE（クライアントシークレット不要）
   - 一覧は IndexedDB にキャッシュし、2回目以降は即表示 → 差分だけ裏で更新
   - 画像・動画の URL は表示直前に window.resolveSrc() で解決する
   ===================================================================== */

// ---- 設定 ----------------------------------------------------------------
const DROPBOX_APP_KEY = "flmwgsm8bvcgljs";   // Dropbox App Console の「App key」（公開して問題ない値）
const ROOT_PATH = "";         // 読み込むフォルダ。例 "/creators"。"" は Dropbox 全体
const FULL_RES = false;       // true にすると投稿内の画像を原寸で表示（通信量が増える）

(function(){
"use strict";
if(!DROPBOX_APP_KEY) return;

const API     = "https://api.dropboxapi.com/2/";
const CONTENT = "https://content.dropboxapi.com/2/";
const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL     = "https://api.dropboxapi.com/oauth2/token";
const LS_AUTH = "dbx-auth";         // トークン（localStorage のみ）
const LS_PKCE = "dbx-pkce";         // 認証中だけ使う一時データ
const DB_NAME = "dbx-gallery";
const STATE_VERSION = 1;

const ROOT = normRoot(ROOT_PATH);
const ROOT_LABEL = ROOT ? ROOT.split("/").pop() : "Dropbox";

const IMG_EXT   = new Set(["jpg","jpeg","png","gif","webp","bmp","heic","heif","avif","tif","tiff"]);
const VID_EXT   = new Set(["mp4","mov","m4v","webm"]);
const THUMB_EXT = new Set(["jpg","jpeg","png","tiff","tif","gif","webp","ppm","bmp"]); // サムネイルAPIの対応形式
const THUMB_MAX_BYTES = 20*1024*1024;                                                  // これより大きい写真はサムネ不可

// 擬似URLの種類ごとのサムネイル設定（cap = Blob URL を保持する上限。超えたら古い順に解放）
const SIZES = {
  thumb: {size:"w640h480",   mode:"fitone_bestfit", batch:25, cap:400}, // 投稿カード（正方形に切り抜いて表示）
  cover: {size:"w1024h768",  mode:"fitone_bestfit", batch:25, cap:60 }, // クリエイターカード・バナー
  full:  {size:"w2048h1536", mode:"bestfit",        batch:5,  cap:40 }, // 投稿内の画像（1枚が重いので少なめにまとめる）
};
const LINK_TTL    = 4*3600e3;   // temporary link の有効期限（約4時間）
const LINK_MARGIN = 10*60e3;    // 期限の10分前には取り直す
const SYNC_INTERVAL = 10*60e3;  // アプリに戻った時、前回同期から10分以上たっていれば差分を取りにいく
const NEAR = 1.5;               // 動画は画面の何倍まで近づいたら URL を用意するか（画像の LOAD_SCREENS と同じ）

const ICON_LOGOUT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';

const MSG_EXPIRED = "Dropbox との接続が切れました。もう一度接続してください。";

/* ---------- 小さな道具 ---------- */
class AuthError extends Error{}
class UserError extends Error{}
class ThumbFail extends Error{}
class ApiError extends Error{
  constructor(status, body){ super("Dropbox API " + status); this.status = status; this.body = body; }
}
const errTag = e => { const b = e && e.body && e.body.error; return b && b[".tag"]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => Math.min(30000, 500 * 2 ** n) + Math.random() * 300;
const escH = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const collator = new Intl.Collator("ja", {numeric:true, sensitivity:"base"});   // index.html の natCmp と同じ比較
const natCmp = (a, b) => collator.compare(String(a), String(b));
function cmpSegs(a, b){
  for(let i = 0; i < Math.min(a.length, b.length); i++){ const c = natCmp(a[i], b[i]); if(c) return c; }
  return a.length - b.length;
}
const extOf  = p => { const n = String(p).split("/").pop(); const i = n.lastIndexOf("."); return i > 0 ? n.slice(i+1).toLowerCase() : ""; };
const nameOf = e => e.n || String(e.d || e.p).split("/").pop();
function normRoot(p){
  p = String(p || "").trim().replace(/\/+$/, "");
  if(p && !p.startsWith("/")) p = "/" + p;
  return p;
}
// ログにはトークン・パス・ファイル名を出さない（状態コードだけ）
function warn(msg, e){
  try{ console.warn("[dropbox] " + msg + (e && e.status ? " (HTTP " + e.status + ")" : "")); }catch(_){}
}

/* =====================================================================
   認証（OAuth 2.0 PKCE / token_access_type=offline）
   ===================================================================== */
// 登録するリダイレクトURIと必ず一致させるため、末尾の index.html は外す
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");

function b64url(bytes){
  let s = ""; for(const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n){ const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function sha256url(str){
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return b64url(new Uint8Array(d));
}

function loadAuth(){
  try{ const a = JSON.parse(localStorage.getItem(LS_AUTH) || "null"); return a && a.r ? a : null; }
  catch(e){ return null; }
}
function saveAuth(a){ try{ localStorage.setItem(LS_AUTH, JSON.stringify(a)); }catch(e){} }
function clearAuth(){ try{ localStorage.removeItem(LS_AUTH); }catch(e){} }

async function login(){
  const verifier = randomString(48);           // 64文字
  const state = randomString(16);
  // 認証から戻った時に元の画面（#/...）へ戻れるよう、ハッシュも一緒に退避する
  localStorage.setItem(LS_PKCE, JSON.stringify({verifier, state, hash: location.hash}));
  const q = new URLSearchParams({
    client_id: DROPBOX_APP_KEY, response_type: "code",
    code_challenge: await sha256url(verifier), code_challenge_method: "S256",
    token_access_type: "offline", redirect_uri: redirectUri(), state,
  });
  location.assign(AUTHORIZE_URL + "?" + q);
}

// ?code=... で戻ってきたらトークンに交換し、クエリを消して元のハッシュに戻す
async function handleRedirect(){
  const q = new URLSearchParams(location.search);
  if(!q.has("code") && !q.has("error")) return false;
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(LS_PKCE) || "null"); }catch(e){}
  try{ localStorage.removeItem(LS_PKCE); }catch(e){}
  history.replaceState(null, "", location.pathname + ((saved && saved.hash) || location.hash || ""));

  if(q.has("error")) throw new UserError("Dropbox への接続がキャンセルされました。");
  if(!saved || saved.state !== q.get("state")) throw new UserError("認証の確認に失敗しました。もう一度「Dropbox に接続」を押してください。");

  const r = await fetch(TOKEN_URL, {method:"POST", body: new URLSearchParams({
    code: q.get("code"), grant_type: "authorization_code", code_verifier: saved.verifier,
    client_id: DROPBOX_APP_KEY, redirect_uri: redirectUri(),
  })});
  if(!r.ok) throw new UserError("認証コードの交換に失敗しました。もう一度「Dropbox に接続」を押してください。");
  const j = await r.json();
  saveAuth({a: j.access_token, r: j.refresh_token, e: Date.now() + (j.expires_in || 14400) * 1000, u: j.account_id || ""});
  return true;
}

let refreshing = null;
async function getToken(force){
  const a = loadAuth();
  if(!a) throw new AuthError();
  if(!force && a.a && a.e - Date.now() > 5*60e3) return a.a;
  if(!refreshing){
    refreshing = (async () => {
      const r = await fetch(TOKEN_URL, {method:"POST", body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: a.r, client_id: DROPBOX_APP_KEY,
      })});
      if(r.status === 400 || r.status === 401){ clearAuth(); throw new AuthError(); } // 取り消し・失効
      if(!r.ok) throw new ApiError(r.status);
      const j = await r.json();
      saveAuth({a: j.access_token, r: a.r, e: Date.now() + (j.expires_in || 14400) * 1000, u: a.u || ""});
      return j.access_token;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/* =====================================================================
   API 呼び出し（並列数の制限・429 / 5xx の再試行・401 の自動更新）
   ===================================================================== */
function limiter(n, lifo){
  let active = 0; const q = [];
  const next = () => {
    if(active >= n || !q.length) return;
    active++;
    const job = lifo ? q.pop() : q.shift();   // サムネは新しい要求（＝今見ている場所）を優先
    job.fn().then(job.res, job.rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { q.push({fn, res, rej}); next(); });
}
const rpcLimit     = limiter(3, false);
const contentLimit = limiter(2, true);

function call(host, endpoint, args, limit){
  return (limit || rpcLimit)(async () => {
    let tries = 0, refreshed = false;
    for(;;){
      const token = await getToken(false);
      let r;
      try{
        r = await fetch(host + endpoint, {method:"POST",
          headers: {"Authorization": "Bearer " + token, "Content-Type": "application/json"},
          body: JSON.stringify(args)});
      }catch(e){                                  // 通信エラー
        if(++tries > 4) throw e;
        await sleep(backoff(tries)); continue;
      }
      if(r.ok) return r.json();

      let body = null;
      try{ body = await r.json(); }catch(e){}
      if(r.status === 401){
        const tag = body && body.error && body.error[".tag"];
        if(tag === "missing_scope"){
          clearAuth();
          throw new UserError("Dropbox アプリの権限が足りません。App Console の Permissions で files.metadata.read と files.content.read を有効にしてから、もう一度接続してください。");
        }
        if(!refreshed){ refreshed = true; await getToken(true); continue; }
        clearAuth(); throw new AuthError();
      }
      if(r.status === 429 || r.status >= 500){
        if(++tries > 6) throw new ApiError(r.status, body);
        // 429 は待つ秒数が本文の retry_after か Retry-After ヘッダで返る（CORS でヘッダが読めない場合に備えて本文を優先）
        let wait = body && body.error && body.error.retry_after;
        if(!(wait > 0)){ const h = Number(r.headers.get("Retry-After")); wait = h > 0 ? h : 0; }
        await sleep(wait > 0 ? wait * 1000 + Math.random() * 300 : backoff(tries));
        continue;
      }
      throw new ApiError(r.status, body);
    }
  });
}

/* =====================================================================
   IndexedDB（一覧・カーソル・変換結果／学習した画像の縦横比）
   ===================================================================== */
let dbPromise = null;
function idb(){
  if(!dbPromise){
    dbPromise = new Promise((res, rej) => {
      if(!window.indexedDB) return rej(new Error("no indexedDB"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("dims"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
function reqP(r){ return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(store, key){ const d = await idb(); return reqP(d.transaction(store).objectStore(store).get(key)); }
async function idbPut(store, key, val){
  const d = await idb(); const t = d.transaction(store, "readwrite");
  t.objectStore(store).put(val, key);
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
async function idbPutMany(store, items){
  const d = await idb(); const t = d.transaction(store, "readwrite"); const s = t.objectStore(store);
  for(const [k, v] of items) s.put(v, k);
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
async function idbAll(store){
  const d = await idb(); const s = d.transaction(store).objectStore(store);
  const [keys, vals] = await Promise.all([reqP(s.getAllKeys()), reqP(s.getAll())]);
  return new Map(keys.map((k, i) => [k, vals[i]]));
}
async function idbDrop(){
  if(dbPromise){ try{ (await dbPromise).close(); }catch(e){} dbPromise = null; }
  if(!window.indexedDB) return;
  await new Promise(res => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

/* =====================================================================
   一覧の取得（list_folder recursive → continue）と差分の適用
   ===================================================================== */
// メディアとフォルダだけを小さな形で保持する（p=path_lower, d=path_display）
function applyEntry(map, e){
  const tag = e[".tag"], p = e.path_lower;
  if(!p) return;
  if(tag === "deleted"){
    map.delete(p);
    const pre = p + "/";
    for(const k of [...map.keys()]) if(k.startsWith(pre)) map.delete(k);
  }else if(tag === "folder"){
    map.set(p, {t:"d", p, d: e.path_display || p, id: e.id || ""});
  }else if(tag === "file"){
    if(mediaKind(p)) map.set(p, {t:"f", p, d: e.path_display || p, n: e.name, m: e.client_modified || e.server_modified || "", s: e.size || 0});
    else map.delete(p);
  }
}

async function fullFetch(onProgress){
  const map = new Map(); let n = 0, res;
  try{
    res = await call(API, "files/list_folder", {path: ROOT, recursive: true, include_media_info: true, limit: 2000});
  }catch(e){
    if(e instanceof ApiError && e.status === 409)
      throw new UserError(`Dropbox に「${ROOT || "/"}」というフォルダが見つかりません。dropbox.js の ROOT_PATH を確認してください。`);
    throw e;
  }
  for(;;){
    for(const e of res.entries) applyEntry(map, e);
    n += res.entries.length;
    if(onProgress) onProgress(n);
    if(!res.has_more) break;
    res = await call(API, "files/list_folder/continue", {cursor: res.cursor});
  }
  return {map, cursor: res.cursor};
}

/* =====================================================================
   window.GALLERY の形へ変換
   <ROOT>/<クリエイター>/<投稿>/... 。投稿より深いファイルは投稿にまとめる
   ===================================================================== */
function mediaKind(p){ const x = extOf(p); return IMG_EXT.has(x) ? "image" : VID_EXT.has(x) ? "video" : ""; }
const thumbable = e => THUMB_EXT.has(extOf(e.p)) && (e.s || 0) <= THUMB_MAX_BYTES;
const isCoverName = e => /^cover\.[^.]+$/i.test(nameOf(e));
// 擬似URL。パスは属性に安全に入るようエンコードする（サムネ非対応の画像は原寸 #orig）
function dbxSrc(e, kind){
  const k = kind === "video" ? "video" : (thumbable(e) ? kind : "orig");
  return "dbx:" + encodeURIComponent(e.p) + "#" + k;
}
function parseSrc(src){
  const i = src.lastIndexOf("#");
  return i > 4 ? {path: decodeURIComponent(src.slice(4, i)), kind: src.slice(i + 1)}
               : {path: decodeURIComponent(src.slice(4)), kind: "orig"};
}
const pickCover = list => list.find(isCoverName) || list.find(thumbable) || list[0] || null;
function dateOf(title, iso){
  const m = /^(\d{4})(\d{2})(\d{2})(?:[-_.\s]|$)/.exec(title);
  if(m){
    const y = +m[1], mo = +m[2], d = +m[3];
    if(y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return iso ? String(iso).slice(0, 10) : "";
}
function fnv(s){ let h = 0x811c9dc5; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
// Dropbox のフォルダ id（"id:xxxx"）を URL に安全な形で使う。フォルダ名を変えても変わらない
const safeId = id => String(id || "").replace(/^id:/, "").replace(/[^A-Za-z0-9_-]/g, "");
function uniq(set, id){ while(set.has(id)) id += "_"; set.add(id); return id; }

function convert(map){
  const depth = ROOT ? ROOT.split("/").length - 1 : 0;
  const creators = new Map();
  // path_display は最後の要素以外の大文字小文字が正確とは限らないので、名前はフォルダ自身のエントリを優先する
  const getC = (k, name, own) => {
    let c = creators.get(k);
    if(!c){ c = {k, name, own:false, id:"", direct:[], posts:new Map()}; creators.set(k, c); }
    if(own && !c.own){ c.name = name; c.own = true; }
    return c;
  };
  const getP = (c, k, name, own) => {
    let p = c.posts.get(k);
    if(!p){ p = {k, name, own:false, id:"", files:[]}; c.posts.set(k, p); }
    if(own && !p.own){ p.name = name; p.own = true; }
    return p;
  };

  for(const e of map.values()){
    const low = e.p.split("/").slice(depth + 1);
    if(!low.length || low.some(s => !s || s[0] === ".")) continue;   // 隠しファイル・隠しフォルダは除外
    let disp = String(e.d || e.p).split("/").slice(depth + 1);
    if(disp.length !== low.length) disp = low;
    if(e.t === "d"){
      if(low.length === 1) getC(low[0], disp[0], true).id = e.id;
      else if(low.length === 2) getP(getC(low[0], disp[0], false), low[1], disp[1], true).id = e.id;
      continue;
    }
    const kind = mediaKind(e.p);
    if(!kind || low.length < 2) continue;                     // ルート直下のファイルは対象外
    const c = getC(low[0], disp[0], false);
    if(low.length === 2){ if(kind === "image") c.direct.push(e); continue; }   // クリエイター直下 = カバー候補
    getP(c, low[1], disp[1], false).files.push({e, kind, segs: disp.slice(2)});
  }

  const out = [], usedC = new Set();
  for(const c of creators.values()){
    const posts = [], usedP = new Set();
    for(const p of c.posts.values()){
      if(!p.files.length) continue;
      p.files.sort((a, b) => cmpSegs(a.segs, b.segs));          // build.py と同じ：パスの自然順
      const media = p.files.map(f => f.kind === "video"
        ? {type:"video", src: dbxSrc(f.e, "video"), name: f.segs.join("/")}
        : {type:"image", src: dbxSrc(f.e, "full"),  name: f.segs.join("/")});
      const ce = pickCover(p.files.filter(f => f.kind === "image").map(f => f.e));
      const post = {id: uniq(usedP, safeId(p.id) || "h" + fnv(c.k + "/" + p.k)),
                    title: p.name, date: dateOf(p.name, p.files[0].e.m), media};
      if(ce) post.cover = dbxSrc(ce, "thumb");
      Object.defineProperty(post, "_ce", {value: ce, enumerable: false});   // カバー決定用（保存・比較には含めない）
      posts.push(post);
    }
    if(!posts.length) continue;
    // クリエイターのカバー：直下の画像（cover.* 優先・名前順）→ 最新の投稿のカバー
    c.direct.sort((a, b) => natCmp(nameOf(a), nameOf(b)));
    let ce = pickCover(c.direct);
    if(!ce){
      const latest = posts.filter(p => p._ce)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || natCmp(b.title, a.title))[0];
      ce = latest ? latest._ce : null;
    }
    posts.sort((a, b) => natCmp(a.title, b.title));
    const item = {id: uniq(usedC, safeId(c.id) || "h" + fnv(c.k)), name: c.name};
    if(ce) item.cover = dbxSrc(ce, "cover");
    item.posts = posts.map(p => ({...p}));                       // _ce を落とす
    out.push(item);
  }
  out.sort((a, b) => natCmp(a.name, b.name));
  return out;
}

/* =====================================================================
   画像の縦横比の学習（list_folder では w/h が取れないため）
   取得したサムネイル JPEG のヘッダから比率を読み、次回の描画から使う
   ===================================================================== */
let dims = new Map();                 // path_lower → [w, h]
let mediaIndex = new Map();           // path_lower → そのファイルを表す media オブジェクト
const dimsDirty = new Map(); let dimsTimer = 0;

function jpegSize(u){
  if(u[0] !== 0xFF || u[1] !== 0xD8) return null;
  let i = 2;
  while(i + 9 < u.length){
    if(u[i] !== 0xFF){ i++; continue; }
    const m = u[i + 1];
    if(m === 0xFF){ i++; continue; }
    if(m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ i += 2; continue; }
    const len = (u[i + 2] << 8) | u[i + 3];
    if(m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC){
      const h = (u[i + 5] << 8) | u[i + 6], w = (u[i + 7] << 8) | u[i + 8];
      return w && h ? [w, h] : null;
    }
    i += 2 + len;
  }
  return null;
}
function indexMedia(g){
  mediaIndex = new Map();
  for(const c of g) for(const p of c.posts) for(const m of p.media){
    if(m.type !== "image") continue;
    const path = parseSrc(m.src).path;
    const d = dims.get(path);
    if(d){ m.w = d[0]; m.h = d[1]; }
    let a = mediaIndex.get(path); if(!a) mediaIndex.set(path, a = []); a.push(m);
  }
}
function learnDims(path, wh){
  if(!wh) return;
  const old = dims.get(path);
  if(old && old[0] === wh[0] && old[1] === wh[1]) return;
  dims.set(path, wh); dimsDirty.set(path, wh);
  // 表示中の DOM は変えず、データ側だけ更新 → 次にその画面を描画した時から正しい比率の枠になる
  const a = mediaIndex.get(path); if(a) for(const m of a){ m.w = wh[0]; m.h = wh[1]; }
  if(!dimsTimer) dimsTimer = setTimeout(flushDims, 2000);
}
function flushDims(){
  clearTimeout(dimsTimer); dimsTimer = 0;
  if(!dimsDirty.size) return;
  const items = [...dimsDirty]; dimsDirty.clear();
  idbPutMany("dims", items).catch(() => {});
}

/* =====================================================================
   window.resolveSrc(src) — 擬似URL → 実際に表示できる URL
   #thumb / #cover / #full : get_thumbnail_batch（まとめて取得）→ Blob URL
   #full + FULL_RES / #orig / #video : get_temporary_link
   ===================================================================== */
const blobs = {thumb: new Map(), cover: new Map(), full: new Map()};   // src → Blob URL（Map の順序で LRU）
const links = new Map();      // src → {url, exp}
const inflight = new Map();   // src → Promise（同じ画像の重複要求をまとめる）
const noThumb = new Set();    // サムネ取得に失敗したパス（以後は temporary link）

function tempLink(path){
  return call(API, "files/get_temporary_link", {path}).then(j => j.link);
}
function cacheBlob(kind, src, url){
  const m = blobs[kind]; m.set(src, url);
  while(m.size > SIZES[kind].cap){
    const [k, u] = m.entries().next().value;
    m.delete(k); URL.revokeObjectURL(u);
  }
}
function b64ToBytes(b64){
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// 20ms のあいだに来た要求をまとめて 1 回の get_thumbnail_batch にする
const batchQ = {};
function thumbnail(path, kind){
  const cfg = SIZES[kind];
  return new Promise((res, rej) => {
    const q = batchQ[kind] || (batchQ[kind] = {items: [], timer: 0});
    q.items.push({path, res, rej});
    if(q.items.length >= cfg.batch) flushBatch(kind);
    else if(!q.timer) q.timer = setTimeout(() => flushBatch(kind), 20);
  });
}
function flushBatch(kind){
  const q = batchQ[kind], cfg = SIZES[kind];
  clearTimeout(q.timer); q.timer = 0;
  while(q.items.length){
    const chunk = q.items.splice(0, cfg.batch);
    call(CONTENT, "files/get_thumbnail_batch",
         {entries: chunk.map(it => ({path: it.path, format: "jpeg", size: cfg.size, mode: cfg.mode}))}, contentLimit)
      .then(j => {
        const list = (j && j.entries) || [];
        chunk.forEach((it, i) => {
          const e = list[i];
          if(e && e[".tag"] === "success" && e.thumbnail) it.res(b64ToBytes(e.thumbnail));
          else it.rej(new ThumbFail());
        });
      })
      .catch(err => chunk.forEach(it => it.rej(err instanceof ApiError && err.status === 409 ? new ThumbFail() : err)));
  }
}

function resolveSrc(src){
  src = String(src);
  if(!src.startsWith("dbx:")) return Promise.resolve(src);
  const {path, kind} = parseSrc(src);
  const useLink = !blobs[kind] || (kind === "full" && FULL_RES) || noThumb.has(path);
  if(useLink){
    const c = links.get(src);
    if(c && c.exp - Date.now() > LINK_MARGIN) return Promise.resolve(c.url);
  }else{
    const m = blobs[kind], u = m.get(src);
    if(u){ m.delete(src); m.set(src, u); return Promise.resolve(u); }   // 最近使ったものとして後ろへ
  }
  if(inflight.has(src)) return inflight.get(src);

  const viaLink = () => tempLink(path).then(url => { links.set(src, {url, exp: Date.now() + LINK_TTL}); return url; });
  const p = (useLink ? viaLink() :
    thumbnail(path, kind).then(bytes => {
      learnDims(path, jpegSize(bytes));
      const url = URL.createObjectURL(new Blob([bytes], {type: "image/jpeg"}));
      cacheBlob(kind, src, url);
      return url;
    }).catch(e => {
      if(e instanceof ThumbFail){ noThumb.add(path); return viaLink(); }   // HEIC・巨大ファイルなど → 原寸
      throw e;
    })
  ).finally(() => inflight.delete(src));
  inflight.set(src, p);
  return p;
}
function invalidate(src){ links.delete(src); }
function releaseAll(){
  for(const m of Object.values(blobs)){ for(const u of m.values()) URL.revokeObjectURL(u); m.clear(); }
  links.clear(); inflight.clear(); noThumb.clear();
}

/* =====================================================================
   画面（未接続・読み込み中・エラー）— 既存のクラスだけで組む
   ===================================================================== */
const appEl = () => document.getElementById("app");
function shell(body){
  return `<div class="topbar"><div class="titles"><div class="kicker">My Gallery</div><h1>${escH(ROOT_LABEL)}</h1></div>`+
    `<button class="theme-btn" onclick="toggleTheme()" aria-label="テーマ切替">◐</button></div>`+
    `<div class="view">${body}</div>`;
}
function renderConnect(note){
  ready = false;
  appEl().innerHTML = shell(
    (note ? `<p class="lede">${escH(note)}</p>` : "")+
    `<p class="lede">Dropbox に保存した画像・動画を表示するには、Dropbox に接続してください。</p>`+
    `<button class="sort-btn" type="button" id="dbx-connect">Dropbox に接続</button>`+
    `<div class="foot">読み込むフォルダ <code>${escH(ROOT || "/")}</code></div>`);
  document.getElementById("dbx-connect").addEventListener("click", () => {
    login().catch(() => renderError("Dropbox の接続画面を開けませんでした。もう一度お試しください。", false));
  });
}
function renderLoading(){
  ready = false;
  appEl().innerHTML = shell(
    `<p class="lede">Dropbox から一覧を取得しています… <span id="dbx-count">0</span> 件</p>`+
    `<p class="lede">初回はファイル数に応じて時間がかかります。2回目以降は保存した一覧ですぐに表示されます。</p>`);
}
function updateLoading(n){ const s = document.getElementById("dbx-count"); if(s) s.textContent = n.toLocaleString(); }
function renderError(msg, retry){
  ready = false;
  appEl().innerHTML = shell(`<p class="lede">${escH(msg)}</p>`+
    (retry ? `<button class="sort-btn" type="button" id="dbx-retry">再読み込み</button>` : ""));
  const b = document.getElementById("dbx-retry");
  if(b) b.addEventListener("click", () => boot());
}

/* =====================================================================
   起動 → キャッシュ表示 → 差分更新
   ===================================================================== */
let H = null;            // index.html から受け取る {setData, route}
let ready = false;       // ギャラリーを表示中か
let gallery = null, entryMap = null, cursor = null;
let syncing = false, lastSync = 0;

// キャッシュは「どのアカウントの・どのフォルダの」一覧かを記録し、違えば使わない
const currentAccount = () => { const a = loadAuth(); return (a && a.u) || ""; };
async function saveState(g){
  await idbPut("kv", "state", {v: STATE_VERSION, root: ROOT, account: currentAccount(), cursor, entries: [...entryMap.values()], gallery: g, savedAt: Date.now()});
}

// 今表示している画面が使うデータだけを比べる（w/h は比べない＝学習で再描画しない）
function viewSig(g, hash){
  if(!g) return "";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if(parts[0] === "c" && parts[1]){
    const c = g.find(x => x.id === parts[1]);
    return JSON.stringify(c ? [c.name, c.cover, c.posts.map(p => [p.id, p.title, p.date, p.cover, p.media.length, p.media.some(m => m.type === "video")])] : null);
  }
  if(parts[0] === "p" && parts[1] && parts[2]){
    const c = g.find(x => x.id === parts[1]), p = c && c.posts.find(x => x.id === parts[2]);
    return JSON.stringify(p ? [c.name, p.title, p.date, p.media.map(m => [m.type, m.src, m.name])] : null);
  }
  return JSON.stringify(g.map(c => [c.id, c.name, c.cover, c.posts.length]));
}

function publish(g, fromSync){
  const old = gallery;
  gallery = g;
  indexMedia(g);
  H.setData(g, ROOT_LABEL);
  if(!ready){
    if(!g.length){ renderError(`「${ROOT || "/"}」の中に表示できる画像・動画が見つかりませんでした。フォルダ構成は <クリエイター>/<投稿>/画像・動画 です。`, true); return; }
    ready = true; H.route(); return;
  }
  if(fromSync && viewSig(old, location.hash) !== viewSig(g, location.hash)){
    const y = window.scrollY;         // 各画面は描画時に先頭へスクロールするので、読んでいた位置に戻す
    H.route();
    if(y) window.scrollTo(0, y);
  }
}

async function boot(){
  let st = null;
  try{
    st = await idbGet("kv", "state");
    dims = await idbAll("dims");
  }catch(e){ st = null; }
  if(st && st.v === STATE_VERSION && st.root === ROOT && st.account === currentAccount() && st.cursor && Array.isArray(st.gallery)){
    entryMap = new Map(st.entries.map(e => [e.p, e]));
    cursor = st.cursor;
    publish(st.gallery, false);       // キャッシュで即表示
    backgroundSync();                 // 差分は裏で
    return;
  }
  renderLoading();
  try{
    const r = await fullFetch(updateLoading);
    entryMap = r.map; cursor = r.cursor; lastSync = Date.now();
    const g = convert(entryMap);
    saveState(g).catch(e => warn("一覧をこの端末に保存できませんでした"));
    publish(g, false);
  }catch(e){ fatal(e); }
}
function fatal(e){
  if(e instanceof AuthError) renderConnect(MSG_EXPIRED);
  else if(e instanceof UserError) renderError(e.message, true);
  else{ warn("一覧の取得に失敗しました", e); renderError("Dropbox から一覧を取得できませんでした。通信環境を確認して、もう一度お試しください。", true); }
}

async function backgroundSync(){
  if(syncing || !entryMap || !cursor) return;
  syncing = true;
  try{
    let changed = false, cur = cursor, res;
    try{
      do{
        res = await call(API, "files/list_folder/continue", {cursor: cur});
        for(const e of res.entries){ applyEntry(entryMap, e); changed = true; }
        cur = res.cursor;
      }while(res.has_more);
    }catch(e){
      if(!(e instanceof ApiError && (e.status === 409 || e.status === 400))) throw e;   // reset・無効なカーソル → 全件取り直し
      const r = await fullFetch(null);
      entryMap = r.map; cur = r.cursor; changed = true;
    }
    lastSync = Date.now();
    if(changed){
      cursor = cur;
      const g = convert(entryMap);
      await saveState(g).catch(() => warn("一覧をこの端末に保存できませんでした"));
      publish(g, true);
    }
  }catch(e){
    if(e instanceof AuthError) renderConnect(MSG_EXPIRED);
    else warn("差分の更新に失敗しました（保存済みの一覧で表示を続けます）", e);
  }finally{ syncing = false; }
}

async function logout(){
  if(!confirm("Dropbox からログアウトしますか？\nこの端末に保存した一覧のキャッシュも削除されます。")) return;
  const a = loadAuth();
  if(a && a.a) fetch(API + "auth/token/revoke", {method: "POST", headers: {"Authorization": "Bearer " + a.a}}).catch(() => {});
  clearAuth();
  try{ localStorage.removeItem(LS_PKCE); }catch(e){}
  clearTimeout(dimsTimer); dimsTimer = 0; dimsDirty.clear();
  releaseAll();
  dims = new Map(); mediaIndex = new Map();
  gallery = null; entryMap = null; cursor = null;
  await idbDrop().catch(() => {});
  H.setData([], ROOT_LABEL);
  renderConnect("ログアウトしました。");
}

/* =====================================================================
   描画のたびに：トップ画面の topbar にログアウトボタン／動画の URL 準備
   ===================================================================== */
function onRendered(){
  if(!ready) return;
  if(!location.hash.replace(/^#\/?/, "")){
    const bar = document.querySelector("#app > .topbar");
    const theme = bar && bar.querySelector(".theme-btn");
    if(theme && !bar.querySelector(".dbx-logout")){
      const b = document.createElement("button");
      b.type = "button"; b.className = "theme-btn dbx-logout";
      b.setAttribute("aria-label", "Dropbox からログアウト"); b.title = "Dropbox からログアウト";
      b.innerHTML = ICON_LOGOUT;
      b.addEventListener("click", logout);
      bar.insertBefore(b, theme);
    }
  }
  scheduleVideoScan();
}

// 動画は preload="none" のまま、近づいた時に URL を入れておく（タップした時にすぐ再生できるように）
let vTick = false;
function scheduleVideoScan(){
  if(vTick) return; vTick = true;
  requestAnimationFrame(() => { vTick = false; scanVideos(); });
}
function scanVideos(){
  if(!ready) return;
  const vh = window.innerHeight || 800;
  document.querySelectorAll("video[data-dbx-src]").forEach(v => {
    if(v.getAttribute("src") || v.dataset.pending) return;
    const r = v.getBoundingClientRect();
    if(r.bottom > -vh * NEAR && r.top < vh * (1 + NEAR)) attachVideo(v, false);
  });
}
async function attachVideo(v, play){
  v.dataset.pending = "1";
  try{
    const url = await resolveSrc(v.dataset.dbxSrc);
    if(!v.isConnected || v.getAttribute("src")) return;
    v.src = url;
    if(play) v.play().catch(() => {});
  }catch(e){ warn("動画の URL を取得できませんでした", e); }
  finally{ delete v.dataset.pending; }
}
function setupVideos(){
  addEventListener("scroll", scheduleVideoScan, {passive: true});
  addEventListener("resize", scheduleVideoScan);
  // 近づく前にタップされた場合の保険
  document.addEventListener("pointerdown", e => {
    const v = e.target && e.target.closest && e.target.closest("video[data-dbx-src]");
    if(v && !v.getAttribute("src") && !v.dataset.pending) attachVideo(v, true);
  }, true);
  // リンクの期限切れなどで再生に失敗したら 1 回だけ取り直す（error はバブリングしないので capture で拾う）
  document.addEventListener("error", e => {
    const v = e.target;
    if(!v || v.tagName !== "VIDEO" || !v.dataset || !v.dataset.dbxSrc || !v.getAttribute("src") || v.dataset.retried) return;
    v.dataset.retried = "1";
    invalidate(v.dataset.dbxSrc);
    v.removeAttribute("src");
    attachVideo(v, false);
  }, true);
}

/* =====================================================================
   index.html から呼ばれる入口
   ===================================================================== */
async function start(hooks){
  H = hooks;
  H.setData([], ROOT_LABEL);                 // サンプル・data.js の内容は出さない
  new MutationObserver(onRendered).observe(appEl(), {childList: true});
  setupVideos();
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden") flushDims();
    else if(ready && Date.now() - lastSync > SYNC_INTERVAL) backgroundSync();
  });
  addEventListener("pagehide", flushDims);

  if(!window.isSecureContext || !(window.crypto && crypto.subtle)){
    renderError("このページは HTTPS（または http://localhost）で開いてください。Dropbox の認証には安全な接続が必要です。", false);
    return;
  }
  try{ await handleRedirect(); }
  catch(e){ renderConnect(e instanceof UserError ? e.message : "Dropbox との接続に失敗しました。もう一度お試しください。"); return; }
  if(!loadAuth()){ renderConnect(); return; }
  await boot();
}

window.resolveSrc = resolveSrc;
window.DBX = {start};
})();
