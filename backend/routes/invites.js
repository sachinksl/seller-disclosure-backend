// backend/routes/invites.js
const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { sendInviteEmail } = require('../email');

const router = express.Router();

/* ---------- helpers ---------- */
const hasAny = (roles, allowed) => (roles || []).some(r => allowed.includes(r));
const requireRole = (...allowed) => (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!hasAny(req.session.user.roles, allowed)) return res.status(403).json({ error: 'forbidden' });
  next();
};

/* ---------- routes ---------- */

/**
 * POST /api/properties/:id/invite
 * Agent/Admin only: create an invite token for a seller email, email it, return link.
 */

router.post('/properties/:id/invite', requireRole('Agent', 'Admin'), async (req, res, next) => {
    try {
      // ✅ safely extract and validate email
      const { email: emailRaw, role: roleRaw } = req.body || {};
      if (typeof emailRaw !== 'string') {
        console.warn('[invite] bad email payload:', req.body); // helpful while debugging
        return res.status(400).json({ error: 'email_must_be_string' });
      }
      const email = emailRaw.trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email_required' });
  
      const role = typeof roleRaw === 'string' && roleRaw ? roleRaw : 'Seller';
  
      // who am I?
      const me = await prisma.user.findUnique({ where: { auth0Sub: req.session.user.sub } });
      if (!me) return res.status(400).json({ error: 'no_user' });
  
      // property must exist & be in my org
      const property = await prisma.property.findUnique({ where: { id: req.params.id } });
      if (!property) return res.status(404).json({ error: 'property_not_found' });
      if (property.orgId !== me.orgId) return res.status(403).json({ error: 'forbidden' });
  
      // create invite
      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
  
      const invite = await prisma.invite.create({
        data: {
          token,
          email,
          role,
          orgId: me.orgId,
          propertyId: property.id,
          createdById: me.id,
          expiresAt,
        },
      });
  
      const appOrigin = process.env.APP_ORIGIN || 'http://localhost:3000';
      const link = `${appOrigin}/invite/${invite.token}`;
  
      // send email, but don't fail API if SMTP breaks
      let emailSent = false;
      let previewUrl = null;
      try {
        const info = await sendInviteEmail(email, link);
        emailSent = true;
        previewUrl = info?.previewUrl || null;
      } catch (err) {
        console.error('[invite email failed]', err?.message || err);
      }
  
      if (process.env.NODE_ENV !== 'production') {
        console.log('[invite link]', link, '→', email);
      }
  
      return res.status(201).json({ ...invite, link, emailSent, previewUrl });
    } catch (e) {
      next(e);
    }
  });
  


/**
 * GET /api/invites/:token
 * Public: let the client show invite details (no PII beyond email/role).
 */
router.get('/invites/:token', async (req, res, next) => {
  try {
    const inv = await prisma.invite.findUnique({ where: { token: req.params.token } });
    if (!inv) return res.status(404).json({ error: 'invalid_token' });
    if (inv.acceptedAt) return res.status(400).json({ error: 'already_accepted' });
    if (inv.expiresAt < new Date()) return res.status(400).json({ error: 'expired' });

    res.json({
      email: inv.email,
      role: inv.role,
      propertyId: inv.propertyId,
      orgId: inv.orgId,
      expiresAt: inv.expiresAt,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/invites/:token/accept
 * Must be logged in; email must match; org must match; updates property.sellerId for Seller.
 */
router.post('/invites/:token/accept', async (req, res, next) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });

    const inv = await prisma.invite.findUnique({ where: { token: req.params.token } });
    if (!inv) return res.status(404).json({ error: 'invalid_token' });
    if (inv.acceptedAt) return res.status(400).json({ error: 'already_accepted' });
    if (inv.expiresAt < new Date()) return res.status(400).json({ error: 'expired' });

    const me = await prisma.user.findUnique({ where: { auth0Sub: req.session.user.sub } });
    if (!me) return res.status(400).json({ error: 'no_user' });
    if (me.orgId !== inv.orgId) return res.status(403).json({ error: 'wrong_org' });

    const sessionEmail = (req.session.user.email || '').toLowerCase();
    if (sessionEmail !== inv.email) {
      return res.status(403).json({ error: 'email_mismatch' });
    }

    if (inv.role === 'Seller') {
      await prisma.property.update({
        where: { id: inv.propertyId },
        data: { sellerId: me.id },
      });
    }
    // (future: support Agent invites, etc.)

    await prisma.invite.update({
      where: { token: inv.token },
      data: { acceptedAt: new Date() },
    });

    res.json({ ok: true, propertyId: inv.propertyId });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
