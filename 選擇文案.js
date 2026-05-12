const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');

const db = JSON.parse(fs.readFileSync('./cases.json', 'utf8'));
const recent = db.cases.slice(-3).reverse(); // 最新的排前面

console.log('\n========================================');
console.log('  芳芳姐理賠筆記 - 選擇今日文案');
console.log('========================================\n');

recent.forEach((c, i) => {
  console.log(`${i + 1}. ${c.news_title}`);
  console.log(`   時間: ${c.created_at ? c.created_at.substring(0,10) : '未知'}\n`);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('選擇哪篇？(輸入 1, 2 或 3): ', (answer) => {
  rl.close();
  const idx = parseInt(answer) - 1;
  if (idx < 0 || idx >= recent.length) {
    console.log('輸入錯誤，請輸入 1-3');
    process.exit(1);
  }
  const selected = recent[idx];
  console.log('\n已選擇：' + selected.news_title);
  console.log('\n========================================');
  console.log(selected.facebook_post);
  console.log('========================================\n');
  
  // 寫入暫存檔
  fs.writeFileSync('latest_post.txt', selected.facebook_post, 'utf8');
  console.log('文案已存入 latest_post.txt');
  console.log('請執行下一行複製到剪貼簿：\n');
  console.log('Get-Content -Path "latest_post.txt" -Encoding UTF8 | Set-Clipboard\n');
});
