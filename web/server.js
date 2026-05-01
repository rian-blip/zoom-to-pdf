const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Groq = require('groq-sdk');
const { Document, Packer, Paragraph, HeadingLevel, AlignmentType } = require('docx');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  const inputPath = req.file.path;
  const audioPath = inputPath + '.mp3';

  try {
    // 音声抽出（最大25分）
    execSync(`ffmpeg -i "${inputPath}" -t 1500 -vn -ar 16000 -ac 1 -b:a 32k "${audioPath}" -y 2>/dev/null`);

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
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `以下はZoomミーティングの文字起こしです。わかりやすい議事録を日本語で作成してください。\n\n【文字起こし】\n${transcript}`
      }]
    });
    const minutes = minutesRes.choices[0].message.content;

    // 提案書生成
    const proposalRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `以下の議事録をもとに、クライアントに送る提案書を日本語で作成してください。ビジネスらしく丁寧に。\n\n【議事録】\n${minutes}`
      }]
    });
    const proposal = proposalRes.choices[0].message.content;

    // Wordファイル生成
    const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

    const textToParas = (text) => text.split('\n').filter(l => l.trim()).map(line =>
      new Paragraph({ text: line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim(), spacing: { after: 160 } })
    );

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: '議事録・提案書', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
          new Paragraph({ text: `作成日：${today}`, alignment: AlignmentType.CENTER, spacing: { after: 600 } }),
          new Paragraph({ text: '■ 議事録', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
          ...textToParas(minutes),
          new Paragraph({ text: '', spacing: { after: 400 } }),
          new Paragraph({ text: '■ 提案書', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
          ...textToParas(proposal),
        ]
      }]
    });

    const fileName = `${today}_議事録・提案書.docx`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);

    res.json({ pdfUrl: `/output/${fileName}` });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 起動中: http://localhost:${PORT}`));
