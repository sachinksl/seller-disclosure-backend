const express = require('express');
const prisma = require('../db');
const { s3 } = require('../storage/s3');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer');

const router = express.Router();

// very small checklist → progress helper (mirrors your properties route)
const CHECKLIST_RULES = {
  house: [
    { id: 'title_search', label: 'Title Search', required: true },
    { id: 'smoke_alarm', label: 'Smoke Alarm Compliance', required: true },
    { id: 'pool_safety', label: 'Pool Safety Certificate', required: false },
  ],
  unit: [
    { id: 'title_search', label: 'Title Search', required: true },
    { id: 'body_corporate', label: 'Body Corporate Disclosure', required: true },
    { id: 'smoke_alarm', label: 'Smoke Alarm Compliance', required: true },
  ],
  default: [
    { id: 'title_search', label: 'Title Search', required: true },
    { id: 'smoke_alarm', label: 'Smoke Alarm Compliance', required: true },
  ],
};
function buildChecklist(property, docs) {
  const rules = CHECKLIST_RULES[property.type?.toLowerCase()] || CHECKLIST_RULES.default;
  const kinds = new Set((docs || []).map(d => d.kind));
  return rules.map(r => ({ ...r, complete: kinds.has(r.id) }));
}

function form2Html(property, checklist) {
  // basic, printable HTML; style to taste later
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Form 2 – ${property.title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 16px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; }
  .ok { color: #0a7f3f; font-weight: 600; }
  .miss { color: #ad1a1a; font-weight: 600; }
</style>
</head>
<body>
  <h1>Queensland Form 2 – Seller Disclosure (Preview)</h1>
  <p><strong>Property:</strong> ${property.title} — ${property.address} — Type: ${property.type}</p>
  <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>

  <h2>Checklist Summary</h2>
  <table>
    <thead><tr><th>Item</th><th>Required</th><th>Status</th></tr></thead>
    <tbody>
      ${checklist.map(i => `
        <tr>
          <td>${i.label}</td>
          <td>${i.required ? 'Yes' : 'No'}</td>
          <td>${i.complete ? '<span class="ok">Complete</span>' : '<span class="miss">Missing</span>'}</td>
        </tr>`).join('')}
    </tbody>
  </table>

  <p style="margin-top:16px;font-size:11px;color:#555">
    This is a system-generated preview PDF for development/testing.
  </p>
</body>
</html>`;
}

async function renderPdf(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'], // safe on local/dev; remove if not needed
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdf;
}

// POST /api/properties/:id/form2/build  -> creates new version, uploads to MinIO
router.post('/properties/:id/form2/build', async (req, res, next) => {
  try {
    const { id } = req.params;
    const property = await prisma.property.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!property) return res.status(404).json({ error: 'not found' });

    const checklist = buildChecklist(property, property.documents);
    const html = form2Html(property, checklist);
    const pdfBuffer = await renderPdf(html);

    const key = `${id}/form2/${Date.now()}.pdf`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    }));

    const latest = await prisma.form2Version.findFirst({
      where: { propertyId: id },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version || 0) + 1;

    const row = await prisma.form2Version.create({
      data: {
        propertyId: id,
        version,
        dataJson: { checklist }, // store a snapshot of what was used
        pdfKey: key,
      },
    });

    res.status(201).json(row);
  } catch (e) { next(e); }
});

// GET /api/properties/:id/form2/latest -> returns latest version metadata
router.get('/properties/:id/form2/latest', async (req, res, next) => {
  try {
    const { id } = req.params;
    const row = await prisma.form2Version.findFirst({
      where: { propertyId: id },
      orderBy: { version: 'desc' },
    });
    if (!row) return res.status(404).json({ error: 'no versions' });
    res.json(row);
  } catch (e) { next(e); }
});

// GET /api/form2/:versionId/download -> stream the PDF from MinIO
router.get('/form2/:versionId/download', async (req, res, next) => {
  try {
    const v = await prisma.form2Version.findUnique({ where: { id: req.params.versionId } });
    if (!v) return res.status(404).json({ error: 'not found' });

    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: v.pdfKey,
    }));
    res.setHeader('Content-Type', obj.ContentType || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline'); // preview in browser
    obj.Body.pipe(res);
  } catch (e) { next(e); }
});

module.exports = router;
