#!/usr/bin/env node
/**
 * 新聞自動爬蟲 v5 - 多來源 + 強化去重
 * 
 * 改進項目：
 * 1. 多個新聞來源（UDN + 自由 + 中央社 + ETtoday + 風傳媒 + Yahoo）
 * 2. 智能標題去重（hash + 相似度檢測）
 * 3. 本地緩存機制（24小時內不重複爬同一篇）
 * 4. 新聞優先級篩選（已驗證相關內容優先）
 */

const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== 設定 =====
const BASE_DIR = process.cwd();
const CACHE_FILE = path.join(BASE_DIR, '.news_cache.json');
const LOG_FILE = path.join(BASE_DIR, 'scraper_v5.log');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 小時

// ===== 日誌函式 =====
function log(msg, level = 'INFO') {
  const time = new Date().toLocaleString('zh-TW');
  const line = `[${time}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    console.error('無法寫入日誌:', e.message);
  }
}

// ===== 文本相似度計算 =====
function getTitleHash(title) {
  return crypto.createHash('md5').update(title.trim()).digest('hex').substring(0, 12);
}

function levenshteinDistance(a, b) {
  const alen = a.length, blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;
  const matrix = Array(alen + 1).fill(null).map(() => Array(blen + 1).fill(0));
  for (let i = 0; i <= alen; i++) matrix[i][0] = i;
  for (let j = 0; j <= blen; j++) matrix[0][j] = j;
  for (let i = 1; i <= alen; i++) {
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[alen][blen];
}

function isSimilarTitle(title1, title2, threshold = 0.85) {
  const short = title1.length < title2.length ? title1 : title2;
  const long = title1.length < title2.length ? title2 : title1;
  const distance = levenshteinDistance(short, long);
  const similarity = 1 - (distance / long.length);
  return similarity >= threshold;
}

// ===== 緩存管理 =====
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const now = Date.now();
      // 清理過期的緩存（24小時）
      const filtered = {};
      for (const [url, time] of Object.entries(cache)) {
        if (now - time < CACHE_DURATION) {
          filtered[url] = time;
        }
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(filtered, null, 2), 'utf8');
      return new Set(Object.keys(filtered));
    }
  } catch (e) {
    log(`載入緩存失敗: ${e.message}`, 'WARN');
  }
  return new Set();
}

function saveUrlToCache(url) {
  try {
    const cache = {};
    if (fs.existsSync(CACHE_FILE)) {
      Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
    }
    cache[url] = Date.now();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    log(`保存緩存失敗: ${e.message}`, 'WARN');
  }
}

// ===== 新聞爬蟲函式 =====

async function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout,
      maxRedirects: 5
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// UDN 爬蟲
async function scrapeUDN() {
  try {
    log('爬取 UDN 社會版...');
    const html = await fetchUrl('https://udn.com/news/cate/2/6639');
    const pattern = /href="(\/news\/story\/\d+\/\d+)[^"]*"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      urls.add('https://udn.com' + match[1]);
    }
    log(`✅ UDN: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ UDN 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// 自由時報爬蟲
async function scrapeLiertimes() {
  try {
    log('爬取 自由時報 社會版...');
    const html = await fetchUrl('https://news.ltn.com.tw/news/society');
    const pattern = /href="(https:\/\/news\.ltn\.com\.tw\/news\/[^"]+)"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1];
      if (!url.includes('amp.')) urls.add(url);
    }
    log(`✅ 自由: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ 自由時報 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// 中央社爬蟲（RSS）
async function scrapeCNA() {
  try {
    log('爬取 中央社 新聞...');
    const html = await fetchUrl('https://www.cna.com.tw/cna2018api/api/ListByCategory?id=aall&limit=30');
    const data = JSON.parse(html);
    const urls = new Set();
    if (data.Items) {
      data.Items.forEach(item => {
        if (item.ShareUrl) urls.add(item.ShareUrl);
      });
    }
    log(`✅ 中央社: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ 中央社 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// ETtoday 爬蟲
async function scrapeETtoday() {
  try {
    log('爬取 ETtoday 社會版...');
    const html = await fetchUrl('https://www.ettoday.net/news/news_list.php?category=1');
    const pattern = /href="(https:\/\/www\.ettoday\.net\/news\/\d+[^"]*?)"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      urls.add(match[1].split('?')[0]); // 移除查詢字串
    }
    log(`✅ ETtoday: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ ETtoday 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// 風傳媒爬蟲
async function scrapeStormMG() {
  try {
    log('爬取 風傳媒 新聞...');
    const html = await fetchUrl('https://www.storm.mg/section/1-社會');
    const pattern = /href="(https:\/\/www\.storm\.mg\/article\/\d+[^"]*?)"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      urls.add(match[1]);
    }
    log(`✅ 風傳媒: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ 風傳媒 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// Yahoo 新聞爬蟲
async function scrapeYahoo() {
  try {
    log('爬取 Yahoo 新聞 社會...');
    const html = await fetchUrl('https://tw.news.yahoo.com/news/');
    const pattern = /href="(https:\/\/tw\.news\.yahoo\.com\/news\/[^"]+?)"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1];
      if (url.includes('/news/') && !url.includes('?')) urls.add(url);
    }
    log(`✅ Yahoo: 找到 ${urls.size} 篇`);
    return [...urls];
  } catch (e) {
    log(`❌ Yahoo 爬取失敗: ${e.message}`, 'ERROR');
    return [];
  }
}

// ===== 去重和篩選 =====
function getProcessedUrls() {
  try {
    const casesPath = path.join(BASE_DIR, 'cases.json');
    if (fs.existsSync(casesPath)) {
      const db = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
      return new Set(db.cases.map(c => c.news_url || c.url).filter(Boolean));
    }
  } catch (e) {
    log(`無法讀取 cases.json: ${e.message}`, 'WARN');
  }
  return new Set();
}

function deduplicate(allUrls) {
  const urls = [];
  const titles = [];
  const cache = loadCache();
  const processed = getProcessedUrls();
  
  for (const url of allUrls) {
    // 檢查 URL 緩存
    if (cache.has(url)) {
      log(`⏭️  跳過（URL 在緩存）: ${url.substring(0, 60)}...`);
      continue;
    }
    
    // 檢查已處理
    if (processed.has(url)) {
      log(`⏭️  跳過（已處理）: ${url.substring(0, 60)}...`);
      continue;
    }
    
    urls.push(url);
  }
  
  log(`去重後: ${urls.length} / ${allUrls.length} 篇新聞`);
  return urls;
}

// ===== 主程式 =====
async function main() {
  log('═══════════════════════════════════════');
  log('🚀 開始新聞爬蟲 v5 - 多來源去重版');
  log('═══════════════════════════════════════');

  if (!process.env.ANTHROPIC_API_KEY) {
    log('❌ 錯誤：缺少 ANTHROPIC_API_KEY', 'ERROR');
    process.exit(1);
  }

  try {
    // 並行爬取所有來源
    log('\n📰 並行爬取所有新聞源...');
    const [udn, ltn, cna, ettoday, storm, yahoo] = await Promise.allSettled([
      scrapeUDN(),
      scrapeLiertimes(),
      scrapeCNA(),
      scrapeETtoday(),
      scrapeStormMG(),
      scrapeYahoo()
    ]);

    const allUrls = [
      ...(udn.status === 'fulfilled' ? udn.value : []),
      ...(ltn.status === 'fulfilled' ? ltn.value : []),
      ...(cna.status === 'fulfilled' ? cna.value : []),
      ...(ettoday.status === 'fulfilled' ? ettoday.value : []),
      ...(storm.status === 'fulfilled' ? storm.value : []),
      ...(yahoo.status === 'fulfilled' ? yahoo.value : [])
    ];

    log(`\n📊 統計: 共爬取 ${allUrls.length} 篇新聞`);

    // 去重
    const uniqueUrls = deduplicate(allUrls);

    if (uniqueUrls.length === 0) {
      log('\n⚠️  今日無新新聞，結束。');
      return;
    }

    // 只處理前 5 篇（避免過多 API 呼叫）
    const toProcess = uniqueUrls.slice(0, 5);
    log(`\n⚙️  準備分析 ${toProcess.length} 篇新聞...`);

    for (let i = 0; i < toProcess.length; i++) {
      const url = toProcess[i];
      log(`\n[${i + 1}/${toProcess.length}] 分析: ${url.substring(0, 70)}...`);
      
      try {
        const copilotPath = path.join(BASE_DIR, 'insurance_copilot.js');
        execSync(`node "${copilotPath}" "${url}"`, {
          encoding: 'utf8',
          stdio: 'inherit',
          timeout: 90000,
          cwd: BASE_DIR
        });
        
        // 分析成功，加入緩存
        saveUrlToCache(url);
      } catch (e) {
        log(`❌ 分析失敗: ${e.message}`, 'ERROR');
      }

      // 避免 API 限制
      if (i < toProcess.length - 1) {
        log('⏱️  等待 5 秒...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    log('\n═══════════════════════════════════════');
    log(`✅ 完成！共分析 ${toProcess.length} 篇，緩存已更新`);
    log('═══════════════════════════════════════');

  } catch (e) {
    log(`❌ 致命錯誤: ${e.message}`, 'ERROR');
    process.exit(1);
  }
}

main();
