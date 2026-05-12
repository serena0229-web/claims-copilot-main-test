# News Scraper v5 - 改進日誌

## 🎯 核心改進

### 1. 多來源新聞爬蟲
- ✅ **UDN 社會版** - 聯合新聞網
- ✅ **自由時報** - 社會版
- ✅ **中央社** - 全類別
- ✅ **ETtoday** - 社會版
- ✅ **風傳媒** - 社會新聞
- ✅ **Yahoo 新聞** - 社會版

**優勢**：
- 從 6 個獨立來源並行爬取，增加新聞多樣性
- 單一來源故障不影響整體運作
- 避免重複爬同一家媒體的相同新聞

### 2. 強化去重機制 - 三層防守

#### 層 1: 緩存去重 (`.news_cache.json`)
- 記錄過去 24 小時爬過的所有 URL
- 自動清理過期記錄
- **作用**：防止同一天重複爬同一篇

#### 層 2: 本地檔案去重 (`cases.json`)
- 已成功處理的新聞用 MD5 hash 記錄
- **作用**：防止歷史新聞再次處理

#### 層 3: Notion 全局去重 (Notion 資料庫)
- 查詢最近 90 天的所有記錄
- title hash + URL 雙檢查
- **作用**：跨執行週期的全局防護

### 3. 標題相似度檢測
```javascript
function isSimilarTitle(title1, title2, threshold = 0.85) {
  // 使用 Levenshtein 距離計算相似度
  // 避免標題稍有不同的重複新聞
}
```

### 4. 並行爬蟲
- 使用 `Promise.allSettled()` 同時爬 6 個來源
- 其中一個失敗不影響其他
- 大幅縮短爬蟲執行時間

### 5. 改進的日誌系統
- 顏色化輸出（✅❌⏭️🚀）
- 記錄到 `scraper_v5.log`
- 便於除錯和監控

---

## 📋 使用方式

### 替換舊版本
```bash
cp news_scraper_v5.js news_scraper.js
```

### 本地測試
```bash
export ANTHROPIC_API_KEY="your_key"
export NOTION_API_KEY="your_key"
node news_scraper_v5.js
```

### GitHub Actions 更新
編輯 `.github/workflows/daily-news.yml`：
```yaml
- name: 執行文案生成
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
  run: |
    echo "===== 開始每日文案生成 (v5) ====="
    node news_scraper_v5.js  # 改成 v5
    node insurance_copilot.js
    echo "===== 完成 ====="
```

---

## 🔧 配置項目

### 可調整參數

**在 `news_scraper_v5.js` 頭部：**

```javascript
const CACHE_DURATION = 24 * 60 * 60 * 1000;  // 緩存有效期（毫秒）
const SIMILARITY_THRESHOLD = 0.85;             // 標題相似度閾值（0-1）
const MAX_ARTICLES_TO_PROCESS = 5;             // 每次最多處理篇數
```

---

## 📊 預期效果

| 指標 | 舊版本 | 新版本 v5 |
|------|--------|----------|
| 新聞來源 | 1 個 | 6 個 |
| 每次爬蟲篇數 | ~20 篇 | ~80-150 篇 |
| 重複率 | 40-50% | < 5% |
| 爬蟲時間 | ~30 秒 | ~10-15 秒（並行） |
| 去重層級 | 2 層 | 3 層 |

---

## ⚠️ 已知限制

1. **某些新聞網站反爬**
   - 某些頁面可能需要 JavaScript 渲染
   - 解決方案：若需要，可用 Puppeteer 升級

2. **API 限制**
   - Claude API 有速率限制
   - 建議每次最多 5-10 篇新聞

3. **繁體中文標題匹配**
   - Levenshtein 距離基於字符，中文效果需驗證
   - 可考慮改用中文分詞庫（如 jieba）

---

## 🧪 測試清單

- [ ] 本地運行一次，驗證多個來源都能爬到新聞
- [ ] 檢查 `.news_cache.json` 是否正確記錄
- [ ] 運行兩次，驗證第二次沒有重複爬蟲
- [ ] 檢查 `scraper_v5.log` 日誌是否清晰
- [ ] 驗證 Notion 是否正確寫入（無重複）
- [ ] 測試其中一個來源故障時的容錯能力

---

## 📞 反饋 & 改進建議

遇到問題時，請提供：
1. `scraper_v5.log` 的完整日誌
2. 當時的 Notion 記錄
3. 具體的重複新聞案例

