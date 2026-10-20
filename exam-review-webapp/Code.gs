/**
 * 照東國小 定期評量審題平台（Google Apps Script 網頁應用程式）
 *
 * 流程：老師在網頁上傳考卷 → 存進審題資料夾（A/B/C 區）→ 由 Claude 排程審題、
 * 產生「主檔名(審題建議)」等回覆檔 → 老師回網頁查看建議，完成時寄信通知。
 *
 * 本程式不審題，也不呼叫任何 AI；審題完全交給原本的排程。
 */

const CONFIG = {
  appTitle: '照東國小 定期評量審題平台',
  kinds: {
    whole: { folderId: '1INfXG8-5XfE0ne4o3pL-Vkh9sLIN_tb6', suffix: '(審題建議)', label: '整份考卷審題' },
    part:  { folderId: '11QAXYtvs4spCOdfs3UlKj0LMNAJbmC9t', suffix: '(出題建議)', label: '單題／多題建議' },
    wish:  { folderId: '1HG2gQKz40Wj_qQ2Eh0je7hV08HnUGo-i', suffix: '(AI出題)', label: '許願出題' }
  },
  exams: ['115上期中', '115上期末', '115下期中', '115下畢業考', '115下期末', '平時'],
  grades: ['一年級', '二年級', '三年級', '四年級', '五年級', '六年級'],
  subjects: ['國語', '數學', '英語', '自然', '社會', '健體', '生活', '綜合', '藝術', '本土語'],
  maxFileMB: 20
};

const APP_TAG = 'exam-review';
const MIME_BY_EXT = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf'
};

// ===== 網頁入口 =====

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.appTitle)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getInit() {
  return {
    email: currentEmail_(),
    exams: CONFIG.exams,
    grades: CONFIG.grades,
    subjects: CONFIG.subjects,
    maxFileMB: CONFIG.maxFileMB
  };
}

// ===== 老師的考卷列表 =====

function getMyItems() {
  const email = currentEmail_();
  const out = [];
  Object.keys(CONFIG.kinds).forEach(function (kindId) {
    const groups = collect_(kindId).groups;
    Object.keys(groups).forEach(function (base) {
      const g = groups[base];
      if (g.uploader !== email) return;
      out.push({
        base: g.base,
        kind: kindId,
        kindLabel: CONFIG.kinds[kindId].label,
        status: g.status,
        uploadedAt: g.latest,
        reviewedAt: g.replyTime || null,
        fileCount: g.files.length
      });
    });
  });
  out.sort(function (a, b) { return b.uploadedAt - a.uploadedAt; });
  return out;
}

// ===== 查看與下載建議 =====

function getSuggestion(kindId, base) {
  const g = findMine_(kindId, base);
  if (!g.reply) throw new Error('這份考卷還沒有審題建議。');
  return {
    base: g.base,
    status: g.status,
    reviewedAt: g.replyTime,
    html: exportDoc_(g.reply, 'html').getDataAsString('UTF-8')
  };
}

function downloadSuggestion(kindId, base) {
  const g = findMine_(kindId, base);
  if (!g.reply) throw new Error('這份考卷還沒有審題建議。');
  const blob = exportDoc_(g.reply, 'docx');
  return {
    name: g.reply.getName() + '.docx',
    mime: MIME_BY_EXT['.docx'],
    data: Utilities.base64Encode(blob.getBytes())
  };
}

// ===== 上傳 =====

/**
 * p = { kind, exam, grade, subject, teacher, wish, replaceBase,
 *       files: [{ role: 'main'|'pdf'|'answer', name, data(base64) }] }
 */
function upload(p) {
  const email = currentEmail_();
  const kind = CONFIG.kinds[p.kind];
  if (!kind) throw new Error('請選擇需要的協助類型。');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = DriveApp.getFolderById(kind.folderId);
    const scan = collect_(p.kind);
    let base, teacher, oldFiles = [];

    if (p.replaceBase) {
      const g = scan.groups[p.replaceBase];
      if (!g || g.uploader !== email) throw new Error('找不到你要更新的考卷。');
      base = g.base;
      teacher = g.teacher;
      oldFiles = g.files;
    } else {
      teacher = cleanName_(p.teacher);
      if (!teacher) throw new Error('請填寫你的姓名。');
      requireIn_(p.exam, CONFIG.exams, '評量別');
      requireIn_(p.grade, CONFIG.grades, '年級');
      requireIn_(p.subject, CONFIG.subjects, '科目');
      base = [p.exam, p.grade, p.subject, teacher].join('_') + (p.kind === 'wish' ? '_許願' : '');
      // 同名就加流水號，避免和別人的檔案或回覆檔撞名
      let candidate = base, n = 2;
      while (scan.names[candidate]) candidate = base + '_' + (n++);
      base = candidate;
    }

    const meta = JSON.stringify({ app: APP_TAG, uploader: email, teacher: teacher, base: base });
    const blobs = p.kind === 'wish' ? [wishBlob_(p, base, teacher)] : fileBlobs_(p.files || [], base);

    // 全部檢查通過後才動檔案：先移除舊版，再建立新版
    oldFiles.forEach(function (f) { f.setTrashed(true); });
    blobs.forEach(function (b) { folder.createFile(b).setDescription(meta); });
    return { base: base };
  } finally {
    lock.releaseLock();
  }
}

function wishBlob_(p, base, teacher) {
  const text = String(p.wish || '').trim();
  if (!text) throw new Error('請寫下你想要什麼樣的題目。');
  if (text.length > 5000) throw new Error('出題需求太長，請精簡到 5000 字以內。');
  const body = [
    '評量別：' + (p.exam || ''),
    '年級：' + (p.grade || ''),
    '科目：' + (p.subject || ''),
    '老師：' + teacher,
    '',
    '出題需求：',
    text
  ].join('\n');
  return Utilities.newBlob(body, 'text/plain', base + '.txt');
}

function fileBlobs_(files, base) {
  if (!files.some(function (f) { return f.role === 'main'; })) throw new Error('請選擇考卷檔案。');
  const used = {};
  return files.map(function (f) {
    const ext = extOf_(f.name);
    if (!MIME_BY_EXT[ext]) throw new Error('「' + f.name + '」格式不支援，請上傳 Word 或 PDF。');
    const bytes = Utilities.base64Decode(f.data);
    if (bytes.length > CONFIG.maxFileMB * 1024 * 1024) {
      throw new Error('「' + f.name + '」超過 ' + CONFIG.maxFileMB + ' MB。');
    }
    let name = base + (f.role === 'answer' ? '-答案' : '') + ext;
    if (used[name]) name = base + (f.role === 'answer' ? '-答案2' : '-2') + ext;
    used[name] = true;
    return Utilities.newBlob(bytes, MIME_BY_EXT[ext], name);
  });
}

// ===== 完成通知（由 setup() 建立的定時觸發器每 10 分鐘執行） =====

function notifyFinished() {
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty('notified') || '{}');
  const next = {};
  const url = ScriptApp.getService().getUrl();
  Object.keys(CONFIG.kinds).forEach(function (kindId) {
    const groups = collect_(kindId).groups;
    Object.keys(groups).forEach(function (base) {
      const g = groups[base];
      if (g.status !== 'done') return;
      const key = g.reply.getId();
      next[key] = 1;
      if (sent[key]) return;
      MailApp.sendEmail({
        to: g.uploader,
        name: CONFIG.appTitle,
        subject: '【審題建議完成】' + g.base,
        body: g.teacher + ' 老師您好：\n\n您上傳的「' + g.base + '」已完成' + CONFIG.kinds[kindId].label +
          '，請到審題平台查看：\n' + url +
          '\n\n（考卷屬保密資料，信中不附檔案。檔案會在審題後第 3 個上課日自動清除，需要請先下載建議。）'
      });
    });
  });
  props.setProperty('notified', JSON.stringify(next));
}

/** 第一次部署前手動執行一次：授權並建立每 10 分鐘的完成通知。 */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'notifyFinished'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('notifyFinished').timeBased().everyMinutes(10).create();
  // 先跑一次，確認三個資料夾都讀得到
  Object.keys(CONFIG.kinds).forEach(function (k) { DriveApp.getFolderById(CONFIG.kinds[k].folderId).getName(); });
}

// ===== 內部工具 =====

function currentEmail_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('無法辨識你的帳號，請用學校的 Google 帳號登入後再開這個網頁。');
  return email.toLowerCase();
}

/**
 * 掃描一個資料夾：把本網頁上傳的老師檔依主檔名分組，並配對回覆檔判斷狀態。
 * 狀態判斷和排程相同：老師檔最後時間晚於回覆檔建立時間 → 重審中。
 */
function collect_(kindId) {
  const kind = CONFIG.kinds[kindId];
  const folder = DriveApp.getFolderById(kind.folderId);
  const groups = {}, replies = {}, names = {};
  const it = folder.searchFiles('trashed = false');
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    if (name.slice(-kind.suffix.length) === kind.suffix) {
      const b = name.slice(0, -kind.suffix.length);
      names[b] = true;
      if (!replies[b] || f.getDateCreated() > replies[b].getDateCreated()) replies[b] = f;
      continue;
    }
    names[name.replace(/(-答案\d*)?(-\d+)?\.[^.]+$/, '')] = true;
    const m = readMeta_(f);
    if (!m) continue;
    const g = groups[m.base] || (groups[m.base] = {
      base: m.base, kind: kindId, uploader: m.uploader, teacher: m.teacher, files: [], latest: 0
    });
    g.files.push(f);
    g.latest = Math.max(g.latest, f.getDateCreated().getTime(), f.getLastUpdated().getTime());
  }
  Object.keys(groups).forEach(function (b) {
    const g = groups[b], r = replies[b];
    if (!r) { g.status = 'queue'; return; }
    g.reply = r;
    g.replyTime = r.getDateCreated().getTime();
    g.status = g.latest > g.replyTime ? 'redo' : 'done';
  });
  return { groups: groups, names: names };
}

function findMine_(kindId, base) {
  if (!CONFIG.kinds[kindId]) throw new Error('類型錯誤。');
  const g = collect_(kindId).groups[base];
  if (!g || g.uploader !== currentEmail_()) throw new Error('找不到這份考卷。');
  return g;
}

function readMeta_(file) {
  try {
    const m = JSON.parse(file.getDescription() || '');
    return m && m.app === APP_TAG ? m : null;
  } catch (e) {
    return null;
  }
}

function exportDoc_(file, format) {
  if (file.getMimeType() !== MimeType.GOOGLE_DOCS) return file.getBlob();
  const url = 'https://docs.google.com/feeds/download/documents/export/Export?id=' +
    file.getId() + '&exportFormat=' + format;
  return UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
}

function cleanName_(s) {
  return String(s || '').replace(/[\\/:*?"<>|_\s]/g, '').slice(0, 20);
}

function requireIn_(value, list, label) {
  if (list.indexOf(value) < 0) throw new Error('請選擇' + label + '。');
}

function extOf_(name) {
  const m = String(name || '').toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : '';
}
