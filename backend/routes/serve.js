// backend/routes/serve.js
const express = require('express');
const prisma = require('../db');
const { s3 } = require('../storage/s3');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const archiver = require('archiver');
const { buildChecklist } = require('../services/form2');

const router = express.Router();

/** Build a ZIP Buffer from S3/MinIO objects */
async function zipFromS3(entries) {
  return new Promise(async (resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];

    archive.on('error', reject);
    archive.on('data', (d) => chunks.push(d));
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      for (const e of entries) {
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: e.key })
        );
        archive.append(obj.Body, { name: e.name });
      }
      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

// POST /api/properties/:id/serve/build
router.post('/properties/:id/serve/build', async (req, res, next) => {
  try {
    const propertyId = req.params.id;

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      include: { documents: true },
    });
    if (!property) return res.status(404).json({ error: 'property not found' });

    const checklist = buildChecklist(property, property.documents);
    const requiredKinds = checklist.filter((i) => i.required).map((i) => i.id);

    const chosenDocs = requiredKinds
      .map((k) => property.documents.find((x) => x.kind === k))
      .filter(Boolean);

    const latestForm2 = await prisma.form2Version.findFirst({
      where: { propertyId },
      orderBy: { version: 'desc' },
    });
    if (!latestForm2) {
      return res.status(400).json({ error: 'Form 2 not generated yet' });
    }

    const entries = [
      ...chosenDocs.map((d) => ({
        key: d.storageKey,
        name: `documents/${d.kind}__${d.filename.replace(/[^\w.\-]+/g, '_')}`,
      })),
      { key: latestForm2.pdfKey, name: `Form2_v${latestForm2.version}.pdf` },
    ];

    const zipBuffer = await zipFromS3(entries);

    const zipKey = `${propertyId}/serve/${Date.now()}.zip`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: zipKey,
        Body: zipBuffer,
        ContentType: 'application/zip',
      })
    );

    const latestPack = await prisma.servePack.findFirst({
      where: { propertyId },
      orderBy: { version: 'desc' },
    });
    const version = (latestPack?.version || 0) + 1;

    const pack = await prisma.servePack.create({
      data: {
        propertyId,
        version,
        zipKey,
        manifest: {
          includedKinds: requiredKinds,
          documents: chosenDocs.map((d) => ({
            id: d.id,
            kind: d.kind,
            filename: d.filename,
          })),
          form2Version: latestForm2.version,
        },
      },
    });

    res.status(201).json(pack);
  } catch (e) {
    next(e);
  }
});

// GET /api/properties/:id/serve/latest
router.get('/properties/:id/serve/latest', async (req, res, next) => {
  try {
    const pack = await prisma.servePack.findFirst({
      where: { propertyId: req.params.id },
      orderBy: { version: 'desc' },
    });
    if (!pack) return res.status(404).json({ error: 'no serve pack' });
    res.json(pack);
  } catch (e) {
    next(e);
  }
});

// GET /api/serve/:packId/download
router.get('/serve/:packId/download', async (req, res, next) => {
  try {
    const pack = await prisma.servePack.findUnique({
      where: { id: req.params.packId },
    });
    if (!pack) return res.status(404).json({ error: 'not found' });

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: pack.zipKey })
    );
    res.setHeader('Content-Type', obj.ContentType || 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="ServePack_v${pack.version}.zip"`
    );
    obj.Body.pipe(res);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
