const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Groq = require('groq-sdk');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = require('docx');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

app.post('/upload', upload.single('file'), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).json({ error: 'ファイルがありません' });

  const inputPath = uploadedFile.path;
  const audioPath = inputPath + '.mp3';
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const pdfName = `${today}_${Date.now()}_議事録・提案書.pdf`;
  const pdfPath = path.join(OUTPUT_DIR, pdfName);

  try {
    // 音声抽出（最大25分に制限）
    execSync(`ffmpeg -i "${inputPath}" -t 1500 -vn -ar 16000 -ac 1 -b:a 32k "${audioPath}" -y 2>/dev/null`);

    // サイズチェック
    const sizeMB = fs.statSync(audioPath).size / (1024 * 1024);
    if (sizeMB > 24) throw new Error('ファイルが大きすぎます。25分以内の録音でお試しください。');

    // 文字起こし
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-large-v3',
      language: 'ja',
    });
    const transcript = transcription.text;

    // 議事録生成
    const minutesRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `以下はZoomミーティングの文字起こしです。わかりやすい議事録を日本語で作成してください。\n\n【フォーマット】\n- 話し合った内容の要点\n- 決定事項\n- 次のアクション\n\n【文字起こし】\n${transcript}`
      }]
    });
    const minutes = minutesRes.choices[0].message.content;

    // 提案資料をJSON形式で生成
    const proposalRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `以下の文字起こしをもとに、クライアントへの提案資料を作成してください。必ず下記のJSON形式で返してください。JSON以外のテキストは一切出力しないでください。

{
  "title": "提案のタイトル（15文字以内）",
  "background": "背景・目的（2〜3文）",
  "problems": ["課題1", "課題2", "課題3"],
  "proposals": [
    {"icon": "絵文字", "title": "提案タイトル", "detail": "説明文"},
    {"icon": "絵文字", "title": "提案タイトル", "detail": "説明文"},
    {"icon": "絵文字", "title": "提案タイトル", "detail": "説明文"}
  ],
  "effects": [
    {"icon": "絵文字", "label": "効果名", "value": "数値や短い説明"},
    {"icon": "絵文字", "label": "効果名", "value": "数値や短い説明"},
    {"icon": "絵文字", "label": "効果名", "value": "数値や短い説明"}
  ],
  "summary": "まとめ（2〜3文）"
}

【文字起こし】
${transcript}`
      }]
    });

    let proposal;
    try {
      const raw = proposalRes.choices[0].message.content.replace(/```json|```/g, '').trim();
      proposal = JSON.parse(raw);
    } catch {
      proposal = null;
    }

    // PDF生成
    const proposalHtml = proposal ? `
      <div class="page-break">
        <!-- 表紙 -->
        <div class="cover">
          <div class="cover-tag">PROPOSAL</div>
          <h1 class="cover-title">${proposal.title}</h1>
          <div class="cover-date">作成日：${today}</div>
        </div>

        <!-- 背景 -->
        <div class="section">
          <div class="section-header blue">
            <span class="section-num">01</span>
            <span class="section-title">背景・目的</span>
          </div>
          <div class="bg-box">${proposal.background}</div>
        </div>

        <!-- 課題 -->
        <div class="section">
          <div class="section-header red">
            <span class="section-num">02</span>
            <span class="section-title">現状の課題</span>
          </div>
          <div class="problems">
            ${proposal.problems.map((p, i) => `
              <div class="problem-item">
                <div class="problem-num">${i + 1}</div>
                <div class="problem-text">${p}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 提案内容 -->
        <div class="section">
          <div class="section-header green">
            <span class="section-num">03</span>
            <span class="section-title">提案内容</span>
          </div>
          <div class="proposals">
            ${proposal.proposals.map(p => `
              <div class="proposal-card">
                <div class="proposal-icon">${p.icon}</div>
                <div class="proposal-body">
                  <div class="proposal-title">${p.title}</div>
                  <div class="proposal-detail">${p.detail}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 期待される効果 -->
        <div class="section">
          <div class="section-header orange">
            <span class="section-num">04</span>
            <span class="section-title">期待される効果</span>
          </div>
          <div class="effects">
            ${proposal.effects.map(e => `
              <div class="effect-card">
                <div class="effect-icon">${e.icon}</div>
                <div class="effect-value">${e.value}</div>
                <div class="effect-label">${e.label}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- まとめ -->
        <div class="section">
          <div class="section-header dark">
            <span class="section-num">05</span>
            <span class="section-title">まとめ</span>
          </div>
          <div class="summary-box">${proposal.summary}</div>
        </div>
      </div>
    ` : `<div class="page-break"><h2>提案書</h2>${marked(proposalRes.choices[0].message.content)}</div>`;

    const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Hiragino Sans', 'Yu Gothic', 'Meiryo', sans-serif; font-size: 12px; line-height: 1.8; color: #222; }

/* 議事録ページ */
.minutes-page { padding: 40px 50px; }
.minutes-cover { background: #f8f8f8; border-radius: 12px; padding: 30px; margin-bottom: 30px; border-left: 6px solid #555; }
.minutes-cover h1 { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 6px; }
.minutes-cover .date { color: #888; font-size: 12px; }
h2 { font-size: 15px; font-weight: bold; color: #333; margin: 24px 0 10px; border-left: 4px solid #aaa; padding-left: 10px; }
p { margin-bottom: 8px; }
ul, ol { padding-left: 18px; margin-bottom: 8px; }
li { margin-bottom: 3px; }
strong { font-weight: bold; }

/* 提案資料ページ */
.page-break { page-break-before: always; padding: 40px 50px; }

/* 表紙 */
.cover { text-align: center; padding: 60px 0 50px; margin-bottom: 40px; border-bottom: 3px solid #1a1a2e; }
.cover-tag { display: inline-block; background: #1a1a2e; color: #fff; padding: 4px 16px; border-radius: 20px; font-size: 11px; letter-spacing: 3px; margin-bottom: 20px; }
.cover-title { font-size: 28px; font-weight: bold; color: #1a1a2e; margin-bottom: 16px; line-height: 1.4; }
.cover-date { color: #888; font-size: 12px; }

/* セクションヘッダー */
.section { margin-bottom: 32px; }
.section-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; }
.section-header.blue { background: #e8f0fe; }
.section-header.red { background: #fce8e6; }
.section-header.green { background: #e6f4ea; }
.section-header.orange { background: #fef3e2; }
.section-header.dark { background: #1a1a2e; }
.section-num { font-size: 11px; font-weight: bold; color: #888; }
.section-header.dark .section-num { color: #aaa; }
.section-title { font-size: 15px; font-weight: bold; color: #1a1a2e; }
.section-header.dark .section-title { color: #fff; }

/* 背景ボックス */
.bg-box { background: #f0f4ff; border-radius: 10px; padding: 18px 20px; font-size: 13px; line-height: 1.9; color: #333; border-left: 4px solid #4a6cf7; }

/* 課題 */
.problems { display: flex; flex-direction: column; gap: 10px; }
.problem-item { display: flex; align-items: center; gap: 14px; background: #fff5f5; border-radius: 10px; padding: 14px 18px; border: 1px solid #fcc; }
.problem-num { width: 28px; height: 28px; background: #e53935; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 13px; flex-shrink: 0; }
.problem-text { font-size: 13px; color: #333; }

/* 提案内容 */
.proposals { display: flex; flex-direction: column; gap: 12px; }
.proposal-card { display: flex; align-items: flex-start; gap: 16px; background: #f8fff8; border-radius: 10px; padding: 16px 18px; border: 1px solid #c8e6c9; }
.proposal-icon { font-size: 28px; flex-shrink: 0; }
.proposal-title { font-size: 14px; font-weight: bold; color: #2e7d32; margin-bottom: 4px; }
.proposal-detail { font-size: 12px; color: #555; line-height: 1.7; }

/* 効果 */
.effects { display: flex; gap: 12px; }
.effect-card { flex: 1; background: #fff8e1; border-radius: 10px; padding: 20px 12px; text-align: center; border: 1px solid #ffe082; }
.effect-icon { font-size: 30px; margin-bottom: 8px; }
.effect-value { font-size: 16px; font-weight: bold; color: #e65100; margin-bottom: 4px; }
.effect-label { font-size: 11px; color: #888; }

/* まとめ */
.summary-box { background: #1a1a2e; color: #fff; border-radius: 10px; padding: 20px 24px; font-size: 13px; line-height: 1.9; }
</style></head><body>

<!-- 議事録ページ -->
<div class="minutes-page">
  <div class="minutes-cover">
    <h1>📋 議事録</h1>
    <div class="date">作成日：${today}</div>
  </div>
  ${marked(minutes)}
</div>

<!-- 提案資料ページ -->
${proposalHtml}

</body></html>`;

    // Word文書を生成
    const makeParas = (text) => text.split('\n').filter(l => l.trim()).map(line => {
      const clean = line.replace(/^#{1,3}\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
      const isHeading = /^#{1,3}\s/.test(line);
      return new Paragraph({
        text: clean,
        heading: isHeading ? HeadingLevel.HEADING_2 : undefined,
        spacing: { after: 120 },
        style: isHeading ? undefined : 'Normal',
      });
    });

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: '議事録・提案書', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
          new Paragraph({ text: `作成日：${today}`, alignment: AlignmentType.CENTER, spacing: { after: 600 } }),
          new Paragraph({ text: '議事録', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '333333' } } }),
          ...makeParas(minutes),
          new Paragraph({ text: '', pageBreakBefore: true }),
          new Paragraph({ text: '提案書', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '333333' } } }),
          ...makeParas(proposal),
        ]
      }]
    });

    const wordName = pdfName.replace('.pdf', '.docx');
    const wordPath = path.join(OUTPUT_DIR, wordName);
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(wordPath, buffer);

    res.json({ pdfUrl: `/output/${wordName}` });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 サーバー起動中: http://localhost:${PORT}`);
});
