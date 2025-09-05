// backend/routes/dashboard.js
const express = require('express');
const prisma = require('../db');
const { buildChecklist } = require('../services/form2');

const router = express.Router();

const isAdmin  = (roles = []) => roles.includes('Admin');
const isAgent  = (roles = []) => roles.includes('Agent');
const isSellerOnly = (roles = []) => roles.includes('Seller') && !isAgent(roles) && !isAdmin(roles);

// GET /api/dashboard/summary
router.get('/dashboard/summary', async (req, res, next) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });

    const roles = req.session.user.roles || [];
    const me = await prisma.user.findUnique({ where: { auth0Sub: req.session.user.sub } });
    if (!me) return res.json({ overall: { completed: 0, total: 0 }, properties: [] });

    const where = { orgId: me.orgId };
    if (isSellerOnly(roles)) {
      where.sellerId = me.id;
    } else if (isAgent(roles) && !isAdmin(roles)) {
      where.agentId = me.id; // <-- critical: agents see only assigned
    }

    // optional: prevent any caching while debugging
    res.set('Cache-Control', 'no-store');

    const props = await prisma.property.findMany({
      where,
      include: { documents: true },
      orderBy: { createdAt: 'desc' },
    });

    const items = props.map(p => {
      const checklist = buildChecklist(p, p.documents);
      const total = checklist.length;
      const completed = checklist.filter(i => i.complete).length;
      return {
        id: p.id,
        title: p.title,
        address: p.address,
        type: p.type,
        progress: { completed, total },
      };
    });

    const overall = items.reduce(
      (acc, p) => ({
        completed: acc.completed + p.progress.completed,
        total: acc.total + p.progress.total,
      }),
      { completed: 0, total: 0 }
    );

    // helpful debug line; remove later
    console.log('[dash]', me.email, roles, 'where:', where, 'count:', items.length);

    res.json({ overall, properties: items });
  } catch (e) { next(e); }
});

module.exports = router;
