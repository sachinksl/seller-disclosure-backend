// ensures a DB user row exists for the logged-in session user
const prisma = require('./db');

module.exports = async function ensureDbUser(req, res, next) {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });

    const { sub, email, name, roles = [], orgId } = req.session.user;

    let me = await prisma.user.findUnique({ where: { auth0Sub: sub } });
    if (!me) {
      // If you don’t yet set orgId in the session, hardcode a dev orgId here or seed one first.
      if (!orgId) return res.status(400).json({ error: 'missing orgId on session' });
      me = await prisma.user.create({
        data: { auth0Sub: sub, email, name, roles, orgId },
      });
    } else {
      // keep core fields fresh
      await prisma.user.update({
        where: { id: me.id },
        data: { email, name, roles },
      });
    }

    req.me = me;
    next();
  } catch (e) {
    next(e);
  }
};
