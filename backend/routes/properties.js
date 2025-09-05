// backend/routes/properties.js
const express = require('express');
const prisma = require('../db');
const { s3 } = require('../storage/s3');
const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { buildChecklist } = require('../services/form2');

const router = express.Router();

/* ---------------- helpers ---------------- */
const hasAny = (roles, allowed) => (roles || []).some(r => allowed.includes(r));
const isAdmin = (roles=[]) => roles.includes('Admin');
const isAgent = (roles=[]) => roles.includes('Agent');
const isSellerOnly = (roles=[]) => roles.includes('Seller') && !isAgent(roles) && !isAdmin(roles);

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!hasAny(req.session.user.roles, allowed)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

async function meFromSession(req) {
  if (!req.session?.user) return null;
  return prisma.user.findUnique({ where: { auth0Sub: req.session.user.sub } });
}

/** load property and enforce org + role-based access */
async function loadAndAuthorizeProperty(req, res, next) {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
    const roles = req.session.user.roles || [];
    const me = await meFromSession(req);
    if (!me) return res.status(400).json({ error: 'no user' });

    const p = await prisma.property.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.orgId !== me.orgId) return res.status(403).json({ error: 'forbidden' });

    // Sellers: only their own
    if (isSellerOnly(roles) && p.sellerId !== me.id) return res.status(403).json({ error: 'forbidden' });

    // Agents (non-admin): only properties where they are assigned as agent
    if (isAgent(roles) && !isAdmin(roles) && p.agentId !== me.id) {
      return res.status(403).json({ error: 'forbidden' });
    }

    req.me = me;
    req.property = p;
    next();
  } catch (e) { next(e); }
}

/* ---------------- routes ---------------- */

/** LIST
 * Seller → only their own
 * Agent (non-admin) → only assigned agentId
 * Admin → all in org
 */
router.get('/', async (req, res, next) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
    const roles = req.session.user.roles || [];
    const me = await meFromSession(req);
    if (!me) return res.json([]);

    const where = { orgId: me.orgId };
    if (isSellerOnly(roles)) where.sellerId = me.id;
    else if (isAgent(roles) && !isAdmin(roles)) where.agentId = me.id;

    const props = await prisma.property.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(props);
  } catch (e) { next(e); }
});

/** CREATE
 * Agents/Admin can create.
 * - Agent: created property is assigned to themselves (agentId = me.id)
 * - Admin: can optionally assign another agent via agentEmail (in same org)
 */
router.post('/', requireRole('Agent', 'Admin'), async (req, res, next) => {
  try {
    const roles = req.session.user.roles || [];
    const me = await meFromSession(req);
    if (!me) return res.status(400).json({ error: 'no user' });

    let { title, address, type, sellerEmail, agentEmail } = req.body || {};
    title = (title || '').trim();
    address = (address || '').trim();
    type = (type || 'house').trim().toLowerCase();
    if (!title || !address) return res.status(400).json({ error: 'title_address_required' });

    // resolve seller
    let sellerId = null;
    if (sellerEmail && sellerEmail.trim()) {
      const seller = await prisma.user.findFirst({
        where: { email: sellerEmail.trim().toLowerCase(), orgId: me.orgId },
      });
      if (!seller) return res.status(400).json({ error: 'seller not found in your org' });
      sellerId = seller.id;
    }

    // resolve agent assignment
    let agentId = me.id; // default: creator agent
    if (agentEmail && agentEmail.trim()) {
      if (!isAdmin(roles)) return res.status(403).json({ error: 'only admin can assign agentEmail' });
      const agent = await prisma.user.findFirst({
        where: { email: agentEmail.trim().toLowerCase(), orgId: me.orgId },
      });
      if (!agent) return res.status(400).json({ error: 'agent not found in your org' });
      agentId = agent.id;
    }

    const created = await prisma.property.create({
      data: { title, address, type, orgId: me.orgId, sellerId, agentId },
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

/** GET one (with checklist/progress) */
router.get('/:id', loadAndAuthorizeProperty, async (req, res, next) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: req.property.id },
      include: { documents: true },
    });
    const checklist = buildChecklist(property, property.documents);
    const total = checklist.length;
    const completed = checklist.filter(i => i.complete).length;

    res.json({
      id: property.id,
      orgId: property.orgId,
      title: property.title,
      address: property.address,
      type: property.type,
      sellerId: property.sellerId,
      agentId: property.agentId,
      createdAt: property.createdAt,
      checklist,
      progress: { completed, total },
    });
  } catch (e) { next(e); }
});

/** OPTIONAL: Admin can reassign agent on a property */
router.post('/:id/assign-agent', requireRole('Admin'), loadAndAuthorizeProperty, async (req, res, next) => {
  try {
    const { agentEmail } = req.body || {};
    if (!agentEmail || !agentEmail.trim()) return res.status(400).json({ error: 'agent_email_required' });

    const me = req.me;
    const agent = await prisma.user.findFirst({
      where: { email: agentEmail.trim().toLowerCase(), orgId: me.orgId },
    });
    if (!agent) return res.status(400).json({ error: 'agent not found in your org' });

    const updated = await prisma.property.update({
      where: { id: req.property.id },
      data: { agentId: agent.id },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

/** DELETE (Agents/Admin)
 * - Admin: any in org
 * - Agent: only if assigned to them
 * - Seller: never
 */
router.delete('/:id', requireRole('Agent', 'Admin'), loadAndAuthorizeProperty, async (req, res, next) => {
  try {
    const roles = req.session.user.roles || [];
    const me = req.me;
    const p = req.property;

    if (isAgent(roles) && !isAdmin(roles) && p.agentId !== me.id) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const propertyId = p.id;
    const bucket = process.env.S3_BUCKET;

    const [docs, form2s, packs] = await Promise.all([
      prisma.document.findMany({ where: { propertyId } }),
      prisma.form2Version.findMany({ where: { propertyId } }),
      prisma.servePack.findMany({ where: { propertyId } }),
    ]);

    const objects = [
      ...docs.map(d => ({ Key: d.storageKey })),
      ...form2s.map(v => ({ Key: v.pdfKey })),
      ...packs.map(pk => ({ Key: pk.zipKey })),
    ].filter(o => o.Key);

    for (let i = 0; i < objects.length; i += 1000) {
      const chunk = objects.slice(i, i + 1000);
      if (chunk.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk } }))
          .catch(err => console.warn('S3 delete warning:', err?.message || err));
      }
    }

    await prisma.$transaction([
      prisma.document.deleteMany({ where: { propertyId } }),
      prisma.form2Version.deleteMany({ where: { propertyId } }),
      prisma.servePack.deleteMany({ where: { propertyId } }),
      prisma.property.delete({ where: { id: propertyId } }),
    ]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
