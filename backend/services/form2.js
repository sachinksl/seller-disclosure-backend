// services/form2.js
const prisma = require('../db');
const { s3 } = require('../storage/s3');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer');

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
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Form 2 – ${property.title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px}
    h1{font-size:20px;margin:0 0 8px} h2{font-size:16px;margin:16px 0 8px}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;font-size:12px}
    .ok{color:#0a7f3f;font-weight:600}.miss{color:#ad1a1a;font-weight:600}
  </style></head><body>
  <h1>Queensland Form 2 – Seller Disclosure (Preview)</h1>
  <p><strong>Property:</strong> ${property.title} — ${property.address} — Type: ${property.type}</p>
  <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
  <h2>Checklist Summary</h2>
  <table><thead><tr><th>Item</th><th>Required</th><th>Status</th></tr></thead><tbody>
    ${checklist.map(i=>`<tr><td>${i.label}</td><td>${i.required?'Yes':'No'}</td>
      <td>${i.complete?'<span class="ok">Complete</span>':'<span class="miss">Missing</span>'}</td></tr>`).join('')}
  </tbody></table>
  <p style="margin-top:16px;font-size:11px;color:#555">Dev preview PDF.</p>
  </body></html>`;
}

async function renderPdf(html) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdf;
}

/** Build a new Form2Version and upload to MinIO. Returns the DB row. */
async function buildForm2Version(propertyId) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { documents: true },
  });
  if (!property) throw new Error('property not found');

  const checklist = buildChecklist(property, property.documents);
  const html = form2Html(property, checklist);
  const pdf = await renderPdf(html);

  const key = `${propertyId}/form2/${Date.now()}.pdf`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: pdf, ContentType: 'application/pdf',
  }));

  const latest = await prisma.form2Version.findFirst({
    where: { propertyId }, orderBy: { version: 'desc' },
  });
  const version = (latest?.version || 0) + 1;

  return prisma.form2Version.create({
    data: { propertyId, version, dataJson: { checklist }, pdfKey: key },
  });
}

module.exports = { buildForm2Version, buildChecklist };
