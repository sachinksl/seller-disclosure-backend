const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const prisma = require('../db');

// Get the S3 client from your helper
const { s3 } = require('../storage/s3');

// Get the command classes directly from the SDK
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const router = express.Router();
//const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });


const MAX = Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024); // 10MB
const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'mimetype'));
  },
});



// POST /api/properties/:id/upload  (multipart/form-data: file, kind)
router.post('/properties/:id/upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'no file' });
  
      const { id } = req.params;
      const { kind = 'supporting' } = req.body;
  
      const prop = await prisma.property.findUnique({ where: { id } });
      if (!prop) return res.status(404).json({ error: 'property not found' });
  
      const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const safeName = req.file.originalname.replace(/[^\w.\-]+/g, '_');
      const key = `${id}/${Date.now()}_${safeName}`;
  
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
      }));
  
      const doc = await prisma.document.create({
        data: {
          propertyId: id,
          kind,
          filename: req.file.originalname,
          storageKey: key,
          sha256,
        }
      });
  
      res.status(201).json(doc);
    } catch (e) {
      // multer file-size errors etc.
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).send('File too large (20MB limit)');
      console.error('Upload error:', e);
      res.status(500).send(e.message || 'Upload failed');
    }
  });

// GET /api/properties/:id/documents
router.get('/properties/:id/documents', async (req, res, next) => {
  try {
    const docs = await prisma.document.findMany({
      where: { propertyId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (e) { next(e); }
});

// GET /api/documents/:docId/download  (stream from MinIO)
router.get('/documents/:docId/download', async (req, res, next) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.docId } });
    if (!doc) return res.status(404).json({ error: 'document not found' });

    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: doc.storageKey,
    }));

    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.filename)}"`);

    // obj.Body is a stream
    obj.Body.pipe(res);
  } catch (e) { next(e); }
});

// DELETE /api/documents/:docId  — remove from MinIO and DB
router.delete('/documents/:docId', async (req, res, next) => {
    try {
      const { docId } = req.params;
  
      const doc = await prisma.document.findUnique({ where: { id: docId } });
      if (!doc) return res.status(404).json({ error: 'document not found' });
  
      // OPTIONAL (strongly recommended): authorization check here
      // - fetch req.session.user, check org / property ownership before allowing delete
  
      // delete from MinIO
      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: doc.storageKey,
        }));
      } catch (e) {
        // If object is already gone, continue deleting DB row
        console.warn('S3 delete warning (continuing):', e?.message || e);
      }
  
      // delete DB row
      await prisma.document.delete({ where: { id: docId } });
  
      res.json({ ok: true });
    } catch (e) {
      console.error('Delete error:', e);
      res.status(500).send(e.message || 'delete failed');
    }
  });
  


module.exports = router;
