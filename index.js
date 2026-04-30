const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Groq = require('groq-sdk');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  console.log('====================================');
  console.log('  Zoom録音 → 議事録・提案書PDF 自動生成');
  console.log('====================================\n');

  // Step 1: inputフォルダの動画ファイルを探す（mp4・mov対応）
  const files = fs.readdirSync(INPUT_DIR).filter(f => /\.(mp4|mov)$/i.test(f));
  if (files.length === 0) {
    console.log('❌ input フォルダにmp4ファイルが見つかりません。');
    console.log('   → input/ フォルダにZoomの録画ファイルを入れてください。');
    return;
  }

  const mp4File = path.join(INPUT_DIR, files[0]);
  console.log(`📹 処理するファイル: ${files[0]}\n`);

  // Step 2: mp4から音声を抽出（ffmpeg）
  console.log('🔊 音声を取り出しています...');
  const audioFile = path.join(INPUT_DIR, 'temp_audio.mp3');
  try {
    execSync(`ffmpeg -i "${mp4File}" -t 60 -vn -ar 16000 -ac 1 -b:a 32k "${audioFile}" -y 2>/dev/null`);
  } catch (e) {
    console.log('❌ ffmpegが見つかりません。');
    console.log('   → ターミナルで「brew install ffmpeg」を実行してください。');
    return;
  }
  console.log('✅ 音声の取り出し完了\n');

  // Step 3: Groq Whisperで文字起こし（25MB制限チェック）
  console.log('📝 文字起こし中...（しばらくお待ちください）');
  const audioStats = fs.statSync(audioFile);
  const audioSizeMB = audioStats.size / (1024 * 1024);
  if (audioSizeMB > 24) {
    console.log('❌ 音声ファイルが大きすぎます（25MB制限）。');
    console.log('   → 録音が長すぎる可能性があります。分割してお試しください。');
    fs.unlinkSync(audioFile);
    return;
  }

  let transcript;
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: 'whisper-large-v3',
      language: 'ja',
    });
    transcript = transcription.text;
  } catch (e) {
    console.log('❌ 文字起こしに失敗しました:', e.message);
    fs.unlinkSync(audioFile);
    return;
  }
  fs.unlinkSync(audioFile);
  console.log('✅ 文字起こし完了\n');

  // Step 4: Groqで議事録を生成
  console.log('📋 議事録を作成中...');
  const minutesRes = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `以下はZoomミーティングの文字起こしです。これをもとに、わかりやすい議事録を日本語で作成してください。

【フォーマット】
- 日時・参加者（わかる場合）
- 話し合った内容の要点
- 決定事項
- 次のアクション

【文字起こし】
${transcript}`
    }]
  });
  const minutes = minutesRes.choices[0].message.content;
  console.log('✅ 議事録の作成完了\n');

  // Step 5: Groqで提案書を生成
  console.log('📄 提案書を作成中...');
  const proposalRes = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `以下の議事録をもとに、クライアントに送る提案書を日本語で作成してください。

【フォーマット】
- はじめに（背景・目的）
- 現状の課題
- 提案内容
- 期待される効果
- まとめ

ビジネスらしく丁寧な文章にしてください。

【議事録】
${minutes}`
    }]
  });
  const proposal = proposalRes.choices[0].message.content;
  console.log('✅ 提案書の作成完了\n');

  // Step 6: PDFを生成
  console.log('📑 PDFを作成中...');
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif;
      font-size: 13px;
      line-height: 1.9;
      color: #222;
      padding: 40px 50px;
    }
    .cover {
      text-align: center;
      padding: 80px 0 60px;
      border-bottom: 2px solid #333;
      margin-bottom: 40px;
    }
    .cover h1 { font-size: 26px; font-weight: bold; margin-bottom: 12px; }
    .cover .date { color: #666; font-size: 13px; }
    h2 {
      font-size: 17px;
      font-weight: bold;
      border-left: 4px solid #333;
      padding-left: 10px;
      margin: 28px 0 14px;
    }
    h3 { font-size: 14px; font-weight: bold; margin: 18px 0 8px; }
    p { margin-bottom: 10px; }
    ul, ol { padding-left: 20px; margin-bottom: 10px; }
    li { margin-bottom: 4px; }
    strong { font-weight: bold; }
    .section { margin-bottom: 50px; }
    .page-break { page-break-before: always; padding-top: 40px; }
    .label {
      display: inline-block;
      background: #333;
      color: #fff;
      padding: 2px 10px;
      font-size: 11px;
      border-radius: 2px;
      margin-bottom: 6px;
    }
  </style>
</head>
<body>

  <div class="cover">
    <h1>ミーティング資料</h1>
    <div class="date">作成日：${today}</div>
  </div>

  <div class="section">
    <span class="label">DOCUMENT 1</span>
    <h2>議事録</h2>
    ${marked(minutes)}
  </div>

  <div class="section page-break">
    <span class="label">DOCUMENT 2</span>
    <h2>提案書</h2>
    ${marked(proposal)}
  </div>

</body>
</html>`;

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfPath = path.join(OUTPUT_DIR, `${today}_議事録・提案書.pdf`);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
    printBackground: true,
  });
  await browser.close();

  // 文字起こしテキストも保存
  const txtPath = path.join(OUTPUT_DIR, `${today}_文字起こし.txt`);
  fs.writeFileSync(txtPath, transcript, 'utf-8');

  console.log('✅ PDF作成完了\n');
  console.log('====================================');
  console.log('  完了！');
  console.log(`  📄 PDF    → output/${today}_議事録・提案書.pdf`);
  console.log(`  📝 テキスト → output/${today}_文字起こし.txt`);
  console.log('====================================\n');
}

main().catch(err => {
  console.error('❌ エラーが発生しました:', err.message);
});
