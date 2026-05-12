#!/usr/bin/env node
/**
 * 新聞自動爬蟲 v4 - 正確 URL pattern
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = 'C:\\Users\\user\\Desktop\\理賠代理人系統';
const LOG_FILE = path.join(BASE_DIR, 'scraper.log');

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-TW')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

function getProcessedUrls() {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'cases.json'), 'utf8'));
    return new Set(db.cases.map(c => c.news_url || c.url).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

function scrapeUDN() {
  try {
    log('抓取 UDN 社會版...');
    const html = execSync(
      'curl.exe -s --max-time 20 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" "https://udn.com/news/cate/2/6639"',
      { encoding: 'utf8' }
    );

    // 從 href 抓 /news/story/數字/數字 格式
    const pattern = /href="(\/news\/story\/\d+\/\d+)[^"]*"/g;
    const urls = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      urls.add('https://udn.com' + match[1]);
    }

    log(`找到 ${urls.size} 篇新聞`);
    return [...urls];
  } catch (e) {
    log(`爬取失敗: ${e.message}`);
    return [];
  }
}

async function main() {
  log('=== 自動新聞分析系統啟動 ===');
  if (!process.env.ANTHROPIC_API_KEY) {
    log('錯誤：找不到 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const urls = scrapeUDN();
  const processed = getProcessedUrls();
  const newUrls = urls.filter(u => !processed.has(u));

  log(`共 ${urls.length} 篇，其中 ${newUrls.length} 篇尚未分析`);

  if (newUrls.length === 0) {
    log('今日無新新聞，結束。');
    return;
  }

  const toProcess = newUrls.slice(0, 3);
  for (let i = 0; i < toProcess.length; i++) {
    const url = toProcess[i];
    log(`分析第 ${i+1}/${toProcess.length} 篇: ${url}`);
    try {
      execSync(`node "${path.join(BASE_DIR, 'insurance_copilot.js')}" "${url}"`, {
        encoding: 'utf8', stdio: 'inherit', timeout: 60000, cwd: BASE_DIR
      });
    } catch (e) {
      log(`分析失敗: ${e.message}`);
    }
    if (i < toProcess.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  log(`=== 完成，共分析 ${toProcess.length} 篇 ===`);
}

main().catch(e => { log(`錯誤: ${e.message}`); process.exit(1); });
