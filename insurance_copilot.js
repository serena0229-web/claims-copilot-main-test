const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// ===== 設定 =====
const NOTION_DB_ID = '54adbdb9ef4f45aa9f767552903f4977';
const MAX_POSTS_PER_RUN = 6;       // 每次最多產生幾篇文案
const SLEEP_BETWEEN_ITEMS = 6000;  // 每篇間隔秒數（避免 API 限制）
const DEDUP_LOOKBACK_DAYS = 90;    // 去重查詢範圍（天數）

// ===== 工具函式 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTitleHash(title) {
  return crypto.createHash('md5').update(title.trim()).digest('hex').substring(0, 8);
}

// ===== 案例類型分類 =====
const CASE_TYPES = {
  DISEASE_VS_ACCIDENT: {
    label: '疾病vs意外認定爭議',
    keywords: ['既往症', '疾病死亡', '意外認定', '拒賠', '疾病不給付', '腦中風', '心肌梗塞', '癌症', '腦瘤', '疾病因素', '非意外'],
    prompt_hint: '核心議題是「疾病vs意外」的認定爭議，強調即使有疾病史，只要死亡/失能的直接原因是意外，仍可理賠'
  },
  PRE_EXISTING: {
    label: '既往症拒賠爭議',
    keywords: ['既往症', '先前疾病', '脊椎', '頸椎', '腰椎', '退化', '三高', '高血壓', '糖尿病', '舊傷', '病史'],
    prompt_hint: '核心議題是「既往症」被拒賠，強調意外是主因，既往症是次因或無關，可申訴'
  },
  MANDATORY_INS: {
    label: '強制險爭議',
    keywords: ['強制險', '強制汽車責任', '特別補償基金', '無保險', '肇事逃逸', '全責', '自撞'],
    prompt_hint: '核心議題是強制險理賠，強調：即使全責也可申請強制險、即使肇逃也有特別補償基金'
  },
  OCCUPATIONAL: {
    label: '職災職業病爭議',
    keywords: ['職業災害', '職業病', '職災', '工傷', '雇主責任', '職保法', '勞基法59', '職業傷害'],
    prompt_hint: '核心議題是職災認定與補償，強調和解書不影響另行申請勞保給付'
  },
  COURT_RULING: {
    label: '司法判決案例',
    keywords: ['判決', '法院', '地方法院', '高等法院', '最高法院', '上訴', '撤銷', '廢棄', '改判', '裁定'],
    prompt_hint: '這是司法判決案例，用判決結果說明消費者勝訴的法律依據，增強說服力'
  },
  DISABILITY: {
    label: '失能殘障理賠',
    keywords: ['失能', '殘廢', '殘障', '失能等級', '植物人', '監護宣告', '輕度', '中度', '重度'],
    prompt_hint: '核心議題是失能等級認定與理賠，強調和解書不影響失能保險金申請'
  },
  PUBLIC_LIABILITY: {
    label: '公共意外險/旅平險',
    keywords: ['公共意外', '旅行平安', '旅平險', '農場', '遊樂場', '商場', '醫院', '公共場所', '跌倒'],
    prompt_hint: '核心議題是公共場所意外，強調場所主人有公共意外險，受害人可申請'
  },
  SETTLEMENT_RIGHTS: {
    label: '和解後仍可申請',
    keywords: ['和解', '和解書', '調解', '調解書', '結案', '放棄', '賠償'],
    prompt_hint: '核心議題是已簽和解書，但仍可申請勞保失能給付或強制險，強調和解書不代表放棄所有權利'
  }
};

function classifyCaseType(title, description) {
  const text = title + ' ' + description;
  for (const [key, type] of Object.entries(CASE_TYPES)) {
    if (type.keywords.some(kw => text.includes(kw))) {
      return { key, ...type };
    }
  }
  return { key: 'GENERAL', label: '一般保險爭議', prompt_hint: '說明消費者的理賠權益' };
}

// ===== 排除關鍵字（無關新聞） =====
const EXCLUDE_KEYWORDS = [
  '美伊', '以色列', '烏克蘭', '俄羅斯', '核武', '戰爭',
  '川普', '拜登', '習近平', '普丁', '國際', '外交', '聯合國',
  '颱風', '地震', '氣象', '鋒面', '豪雨', '寒流',
  '台股', '股市', '大盤', 'ETF', '存股', '漲停', '跌停',
  '選舉', '立法院', '總統府', '罷免',
  '藝人', '明星', '演員', '歌手', '綜藝',
  '西部防雷', '東北季風', '基金', '投資', '理財規劃'
];

// ===== 必要關鍵字（業務相關） =====
const INCLUDE_KEYWORD_GROUPS = [
  ['拒賠', '不理賠', '拒絕理賠', '保險爭議', '申訴'],
  ['意外認定', '疾病死亡', '既往症', '原有疾病', '先天'],
  ['強制險', '強制汽車責任保險', '特別補償基金'],
  ['職業災害', '職業病', '工傷', '勞基法59條', '職保法'],
  ['失能', '植物人', '監護宣告', '殘廢等級'],
  ['公共意外險', '旅平險', '醫院跌倒', '農場意外'],
  ['保險判決', '理賠判決', '保險公司敗訴', '消費者勝訴'],
  ['車禍', '交通事故', '職災', '意外', '骨折', '重傷'].filter(() => true)
];

function isRelevant(title, description) {
  const text = title + ' ' + description;
  if (EXCLUDE_KEYWORDS.some(kw => text.includes(kw))) return false;

  const highPriority = INCLUDE_KEYWORD_GROUPS.slice(0, 7);
  if (highPriority.some(group => group.some(kw => text.includes(kw)))) return true;

  const hasAccident = ['車禍', '交通事故', '職災', '意外', '骨折', '重傷', '死亡'].some(kw => text.includes(kw));
  const hasInsurance = ['保險', '理賠', '賠償', '給付', '補償'].some(kw => text.includes(kw));
  return hasAccident && hasInsurance;
}

// ===== RSS 資料來源（優化版 - 去掉重複度高的源） =====
const RSS_SOURCES = [
  // --- 強制險（獨立議題）---
  { url: 'https://news.google.com/rss/search?q=強制汽車責任保險+理賠+爭議&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '強制險爭議' },
  { url: 'https://news.google.com/rss/search?q=車禍+強制險+全責+申請&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '強制險全責' },

  // --- 職災（獨立議題）---
  { url: 'https://news.google.com/rss/search?q=職業災害+補償+爭議+判決&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '職災補償判決' },
  { url: 'https://news.google.com/rss/search?q=勞基法+職業災害+雇主+補償&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '勞基法職災' },
  { url: 'https://news.google.com/rss/search?q=工傷+勞工+保險+給付+拒賠&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '工傷勞保給付' },

  // --- 失能（獨立議題）---
  { url: 'https://news.google.com/rss/search?q=失能+保險+給付+爭議&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '失能保險爭議' },
  { url: 'https://news.google.com/rss/search?q=植物人+監護宣告+保險+理賠&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '植物人監護宣告' },

  // --- 疾病 vs 意外（核心業務）---
  { url: 'https://news.google.com/rss/search?q=保險+死亡+自殺+意外認定&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '自殺 vs 意外認定' },

  // --- 公共意外 ---
  { url: 'https://news.google.com/rss/search?q=公共意外險+理賠&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '公共意外險' },
  { url: 'https://news.google.com/rss/search?q=旅平險+意外+理賠+爭議&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '旅平險爭議' },

  // --- 司法判決（高價值）---
  { url: 'https://news.google.com/rss/search?q=保險公司+敗訴+法院+判決&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '保險公司敗訴判決' },

  // --- 評議中心 ---
  { url: 'https://news.google.com/rss/search?q=保險申訴+評議中心+裁決&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', label: '保險評議中心' }
];

// ===== Notion 查詢今日已處理標題（修正：查詢過去 90 天） =====
async function getTodayTitlesFromNotion() {
  const notionKey = process.env.NOTION_API_KEY;
  const today = new Date();
  const lookbackDate = new Date(today.getTime() - DEDUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fromDate = lookbackDate.toISOString().substring(0, 10);

  const body = JSON.stringify({
    filter: {
      property: '建立日期',
      date: { on_or_after: fromDate }  // 查詢最近 90 天
    },
    page_size: 500  // 提高上限以容納更多記錄
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/databases/${NOTION_DB_ID}/query`,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const titles = new Set();
          const urls = new Set();
          if (result.results) {
            for (const page of result.results) {
              const titleProp = page.properties?.['新聞標題'];
              const urlProp = page.properties?.['新聞來源'];
              if (titleProp?.title?.[0]?.text?.content) {
                const hash = getTitleHash(titleProp.title[0].text.content);
                titles.add(hash);
              }
              if (urlProp?.url) urls.add(urlProp.url);
            }
          }
          console.log(`✅ Notion 查詢完成：${titles.size} 筆標題 + ${urls.size} 個 URL（最近 ${DEDUP_LOOKBACK_DAYS} 天）`);
          resolve({ titles, urls });
        } catch (e) {
          console.log('查詢 Notion 失敗:', e.message);
          resolve({ titles: new Set(), urls: new Set() });
        }
      });
    });
    req.on('error', () => resolve({ titles: new Set(), urls: new Set() }));
    req.write(body);
    req.end();
  });
}

// ===== Notion 寫入（新增案例類型欄位） =====
async function saveToNotion(title, post, newsUrl, sourceName, caseType) {
  const notionKey = process.env.NOTION_API_KEY;

  const body = JSON.stringify({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      '新聞標題': { title: [{ text: { content: title.substring(0, 100) } }] },
      '文案內容': { rich_text: [{ text: { content: post.substring(0, 2000) } }] },
      '新聞來源': { url: newsUrl },
      '狀態': { select: { name: '草稿' } },
      '案例類型': { select: { name: caseType.label || '一般保險爭議' } }
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.notion.com',
      path: '/v1/pages',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.object === 'error') {
          if (result.message && result.message.includes('案例類型')) {
            console.log('  ⚠️ Notion 無「案例類型」欄位，略過該欄寫入');
            resolve(result);
          } else {
            console.log('Notion錯誤:', result.message);
            reject(new Error(result.message));
          }
        } else {
          console.log('✅ 已存入 Notion！');
          resolve(result);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ===== 抓取 URL（含重新導向） =====
function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('重新導向次數過多'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      },
      timeout: 15000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        let location = res.headers.location;
        if (!location) return reject(new Error('重新導向無目標'));
        if (!location.startsWith('http')) {
          const base = new URL(url);
          location = base.origin + location;
        }
        res.resume();
        return fetchUrl(location, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getSourceNameFromUrl(url) {
  if (!url) return '';
  const map = {
    'cna.com.tw': '中央社',
    'udn.com': '聯合新聞網',
    'ltn.com.tw': '自由時報',
    'ettoday.net': 'ETtoday',
    'mirrormedia.mg': '鏡週刊',
    'chinatimes.com': '中時新聞網',
    'tvbs.com.tw': 'TVBS',
    'setn.com': '三立新聞',
    'storm.mg': '風傳媒',
    'yahoo.com': 'Yahoo新聞',
    'mol.gov.tw': '勞動部',
    'bli.gov.tw': '勞保局',
    'fsc.gov.tw': '金管會',
    'judicial.gov.tw': '司法院'
  };
  for (const [domain, name] of Object.entries(map)) {
    if (url.includes(domain)) return name;
  }
  return '';
}

async function resolveRealUrl(url) {
  if (!url) return { url: '', sourceName: '新聞報導' };
  if (!url.includes('msn.com') && !url.includes('news.google.com')) {
    return { url, sourceName: getSourceNameFromUrl(url) || '新聞報導' };
  }
  try {
    const html = await fetchUrl(url);
    const patterns = [
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i,
      /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i,
      /"providerUrl"\s*:\s*"([^"]+)"/,
      /"url"\s*:\s*"(https:\/\/(?!.*msn\.com)[^"]+)"/
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1] && !match[1].includes('msn.com') && !match[1].includes('news.google.com') && match[1].startsWith('http')) {
        const realUrl = match[1];
        return { url: realUrl, sourceName: getSourceNameFromUrl(realUrl) || '新聞報導' };
      }
    }
    return { url, sourceName: '新聞報導' };
  } catch (e) {
    return { url, sourceName: '新聞報導' };
  }
}

async function fetchFullContent(url) {
  if (!url || url.includes('news.google.com') || url.includes('msn.com')) return null;
  try {
    const html = await fetchUrl(url);
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const main = articleMatch ? articleMatch[1] : html;
    const content = main
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    if (content.length > 200) return content.substring(0, 2000);
    return null;
  } catch (e) {
    return null;
  }
}

function parseRSS(xml, limit = 3) {
  const items = [];
  const itemPattern = /<item[\s\S]*?<\/item>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const item = match[0];
    const titleMatch = item.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) ||
                       item.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : '';
    const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                      item.match(/<description>([\s\S]*?)<\/description>/);
    let description = descMatch ? descMatch[1] : '';
    description = description
      .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim().substring(0, 500);
    const linkMatch = item.match(/<link>([^<]+)<\/link>/) || item.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const link = linkMatch ? linkMatch[1].trim() : '';
    const sourceMatch = item.match(/<source[^>]*url="([^"]*)"[^>]*>([^<]+)<\/source>/);
    const sourceName = sourceMatch ? sourceMatch[2].trim() : '';
    if (title && title.length > 5) items.push({ title, description, link, sourceName });
    if (items.length >= limit) break;
  }
  return items;
}

// ===== Claude 文案生成 =====
function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          if (d.content && d.content[0]) resolve(d.content[0].text);
          else reject(new Error('Claude 無回應: ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function cleanText(text) {
  return text
    .replace(/[◆◇■□▲▼△▽◎]/g, '')
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/---+/g, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// ===== 根據案例類型建立專屬 prompt =====
function buildPrompt(title, newsContent, contentType, sourceDisplay, caseType) {
  const legalReminders = {
    DISEASE_VS_ACCIDENT: `
【此案例法律重點（擇相關者寫入）】
- 意外保險的「外來、突發、非疾病」三要件
- 最高法院見解：疾病是誘因但意外是直接死因，仍應理賠
- 保險法第 131 條：傷害保險以被保險人遭受意外傷害為要件
- 舉證責任：保險公司需舉證死因是疾病而非意外`,

    PRE_EXISTING: `
【此案例法律重點（擇相關者寫入）】
- 既往症需是「直接原因」才能拒賠，非直接原因不得拒賠
- 保險法第 127 條：要保人故意不告知不等於保險公司可無限拒賠
- 加速條款vs誘因條款的區別
- 脊椎/頸椎問題是退化性疾病不代表「不能理賠」意外造成的加重`,

    MANDATORY_INS: `
【此案例法律重點（擇相關者寫入）】
- 強制汽車責任保險法：全責方亦可申請強制險（非過失補償）
- 傷亡給付上限：死亡最高 220 萬、失能依等級、醫療費最高 20 萬
- 特別補償基金：肇逃、無保險車輛仍可申請
- 申請對象：向肇事車輛的強制險保險公司申請，非向自己保險公司`,

    OCCUPATIONAL: `
【此案例法律重點（擇相關者寫入）】
- 勞基法第 59 條：職災補償（醫療、工資、失能、死亡）
- 職業災害勞工保護法：擴大職災認定範圍
- 勞保職災傷病給付：住院期間工資補償 70%
- 重要：和解書上的賠償金額不影響另行申請勞保給付`,

    DISABILITY: `
【此案例法律重點（擇相關者寫入）】
- 失能等級表：共 11 等級，第 1 級最重（完全失能）
- 監護宣告 ≠ 必要前提：部分保險合約要求，但法律未強制
- 和解書載明「拋棄其他請求」但失能保險金屬獨立保單，不受影響
- 失能申請期限：通常自確診或事故起算 2 年內`,

    SETTLEMENT_RIGHTS: `
【此案例法律重點（擇相關者寫入）】
- 調解書/和解書的效力範圍：只及於調解當事人間的民事賠償
- 不影響勞保局給付（勞保給付是公法請求權，非民事賠償）
- 不影響強制險申請（強制險是法定給付，不是損害賠償）
- 已簽和解後仍可申請：失能保險金、勞保傷病/失能/死亡給付`,

    PUBLIC_LIABILITY: `
【此案例法律重點（擇相關者寫入）】
- 公共意外責任險：場所業者應投保，受害人可直接求償
- 民法第 191 條：公共場所管理人的侵權責任
- 醫院、商場、農場、遊樂場均應投保公共意外險
- 旅平險：旅遊期間意外，須有清楚的「意外」認定`,

    COURT_RULING: `
【此案例法律重點】
- 引用法院判決結果，強調消費者/勞工獲得理賠/補償
- 說明判決確認的法律原則
- 這個案例可作為類似受害者的申請依據`,

    GENERAL: `
【此案例法律重點（擇相關者寫入）】
- 保險法、職業災害勞工保護法、強制汽車責任保險法相關規定
- 申請程序與期限`
  };

  const legalHint = legalReminders[caseType.key] || legalReminders.GENERAL;

  return `請根據以下新聞，用繁體中文寫一篇Facebook貼文，約350-400字。

【此新聞的業務類型】：${caseType.label}
【寫作重點提示】：${caseType.prompt_hint}
${legalHint}

【絕對禁止，違反即為錯誤輸出】
開頭禁止使用：「芳芳姐」、「跟大家說」、「今天要跟」、「來跟大家」、「想跟大家」、「親愛的朋友們」、「讓我告訴你」、「大家好」

內容規定：
- 只能根據提供的新聞內容寫作，不可添加新聞未出現的情節
- 法律數字不確定就不寫，用「依規定計算」代替
- 禁止 Markdown（**粗體**、# 標題、--- 分隔線）
- 禁止 ◆◇■□▲▼ 等符號

【寫作風格】
- 開頭直接切入情境，親切溫暖像朋友提醒
- 條列重點用 ✅ 💡 ⚠️ 等 emoji
- 段落之間空一行
- 語氣：像朋友在提醒你「你有這個權利，別放棄」

【文案結構】
1. 開頭：用貼近新聞的情境切入（一句話，帶入讀者）

2. 案例說明：根據新聞內容改寫，情境忠實呈現新聞

3. 法律重點：2-3個相關條文（每點 ✅ 開頭，只寫確定的）

4. 重要提醒：2-3個可操作的實用建議（每點 💡 開頭）

5. 結尾CTA（固定格式，不可更改）：
有類似情況嗎？先別急著放棄 🙏
在留言打【評估】，或加 LINE：0922388397 傳「#理賠評估」，我直接幫你看

6. 免責聲明（固定，不可更改）：
⚠️ 本文依據新聞報導改寫，每個案件情況不同，實際理賠權益應以客觀法源及個案事實為準，建議諮詢專業人員進行個案評估。

7. 最後兩行（順序不可更改）：
📰 資料來源：${sourceDisplay}
（5-8個 hashtag，必須含 #芳芳姐理賠筆記，並加入與案例類型相關的標籤如 #意外險 #拒賠 #職業災害 等）

新聞標題：${title}
新聞內容（${contentType}）：${newsContent}`;
}

// ===== 處理單篇新聞 =====
async function processItem(item, processedTitles, processedUrls, db, localTitles) {
  const { title, description, link } = item;

  const hash = getTitleHash(title);
  
  // 三層檢查：(1) Notion 全局, (2) 本地快取, (3) 本次執行
  if (processedTitles.has(hash)) {
    console.log('  ⏭️  全局重複（Notion）:', title.substring(0, 35));
    return false;
  }
  if (localTitles.has(hash)) {
    console.log('  ⏭️  本地歷史:', title.substring(0, 35));
    return false;
  }

  if (!isRelevant(title, description)) {
    console.log('  ⏭️  不相關跳過:', title.substring(0, 40));
    return false;
  }

  const caseType = classifyCaseType(title, description);
  console.log(`  ✓ [${caseType.label}] ${title.substring(0, 45)}`);

  const { url: realUrl, sourceName } = await resolveRealUrl(link);

  if (realUrl && (processedUrls.has(realUrl) || db.cases.some(c => c.news_url === realUrl))) {
    console.log('  ⏭️  URL 重複');
    return false;
  }

  const fullContent = await fetchFullContent(realUrl);
  const newsContent = fullContent || description || '（僅有標題）';
  const contentType = fullContent ? '全文' : '摘要';
  console.log(`    使用${contentType}（${newsContent.length}字）`);

  const sourceDisplay = (realUrl && !realUrl.includes('news.google.com') && !realUrl.includes('msn.com'))
    ? `${sourceName} ${realUrl}`
    : sourceName;

  const prompt = buildPrompt(title, newsContent, contentType, sourceDisplay, caseType);

  let post;
  try {
    post = await callClaude(prompt);
    post = cleanText(post);
    console.log('  ✅ 文案產生完成');
  } catch (e) {
    console.log('  ✗ Claude 失敗:', e.message);
    return false;
  }

  const saveUrl = (realUrl && !realUrl.includes('news.google.com')) ? realUrl : (link || 'https://news.google.com');

  try {
    await saveToNotion(title, post, saveUrl, sourceName, caseType);
  } catch (e) {
    console.log('  ✗ Notion存入失敗:', e.message);
    return false;
  }

  processedTitles.add(hash);
  if (realUrl) processedUrls.add(realUrl);

  db.cases.push({
    id: 'case_' + Date.now(),
    created_at: new Date().toISOString(),
    news_url: saveUrl,
    news_title: title,
    case_type: caseType.label,
    hash,
    source_name: sourceName,
    content_type: contentType,
    status: 'draft'
  });

  return true;
}

// ===== 主程式 =====
async function main() {
  console.log('===== 芳芳姐理賠文案系統 v2.1（優化去重版）=====\n');

  const { titles: processedTitles, urls: processedUrls } = await getTodayTitlesFromNotion();

  let db = { cases: [] };
  try { db = JSON.parse(fs.readFileSync('cases.json', 'utf8')); } catch (e) {}

  // 融合本地快取中的歷史標題
  const localTitles = new Set();
  for (const c of db.cases) {
    if (c.hash) localTitles.add(c.hash);
  }
  processedTitles.forEach(t => localTitles.add(t));
  console.log(`✅ 加載本地快取：${localTitles.size} 筆歷史標題\n`);

  const candidates = [];
  const seenTitles = new Set();

  // 1. 抓 RSS 新聞
  for (const source of RSS_SOURCES) {
    try {
      console.log(`抓取 RSS：${source.label}`);
      const xml = await fetchUrl(source.url);
      const items = parseRSS(xml, 3);
      console.log(`  找到 ${items.length} 篇`);
      for (const item of items) {
        const hash = getTitleHash(item.title);
        
        // 檢查本次執行中的重複
        if (seenTitles.has(item.title)) {
          console.log(`    ⏭️  本次重複：${item.title.substring(0, 30)}`);
          continue;
        }
        
        // 檢查歷史記錄
        if (localTitles.has(hash)) {
          console.log(`    ⏭️  歷史記錄：${item.title.substring(0, 30)}`);
          continue;
        }
        
        seenTitles.add(item.title);
        candidates.push(item);
      }
    } catch (e) {
      console.log(`  ✗ RSS 失敗 (${source.label}):`, e.message);
    }
    await sleep(1500);
  }

  // 案例類型統計
  const typeSummary = {};
  for (const c of candidates) {
    const ct = classifyCaseType(c.title, c.description);
    typeSummary[ct.label] = (typeSummary[ct.label] || 0) + 1;
  }
  console.log(`\n📊 收集到 ${candidates.length} 篇候選新聞`);
  for (const [type, count] of Object.entries(typeSummary)) {
    console.log(`   ${type}: ${count} 篇`);
  }
  console.log('\n開始篩選處理...\n');

  let count = 0;
  for (const item of candidates) {
    if (count >= MAX_POSTS_PER_RUN) break;
    const success = await processItem(item, processedTitles, processedUrls, db, localTitles);
    if (success) count++;
    await sleep(SLEEP_BETWEEN_ITEMS);
  }

  fs.writeFileSync('cases.json', JSON.stringify(db, null, 2));
  console.log(`\n===== 完成！共產生 ${count} 篇文案，請至 Notion 確認 =====`);

  const todayTypes = db.cases
    .filter(c => c.created_at?.startsWith(new Date().toISOString().substring(0, 10)))
    .reduce((acc, c) => {
      acc[c.case_type] = (acc[c.case_type] || 0) + 1;
      return acc;
    }, {});
  if (Object.keys(todayTypes).length > 0) {
    console.log('\n📋 今日文案類型分佈：');
    for (const [type, count] of Object.entries(todayTypes)) {
      console.log(`   ${type}: ${count} 篇`);
    }
  }
}

main().catch(e => console.error('錯誤:', e.message));
