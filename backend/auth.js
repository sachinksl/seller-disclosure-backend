// backend/auth.js
const { Issuer, generators } = require('openid-client');
const express = require('express');
const router = express.Router();

const {
  AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,
  AUTH0_AUDIENCE, BACKEND_URL, FRONTEND_URL
} = process.env;

let client;
(async () => {
    if (!BACKEND_URL) throw new Error('Missing BACKEND_URL in .env');
  const domain = (AUTH0_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const issuer = await Issuer.discover(`https://${domain}/`);
  client = new issuer.Client({
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    redirect_uris: [`${BACKEND_URL}/auth/callback`],  // <— backend callback
    response_types: ['code'],
  });
})();

router.get('/login', (req, res, next) => {
  try {
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    req.session.codeVerifier = codeVerifier;

    const url = client.authorizationUrl({
      scope: 'openid profile email',
      audience: AUTH0_AUDIENCE || undefined,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      screen_hint: 'login',
    });
    console.log('Auth0 authorize URL ->', url); 

    req.session.save(err => (err ? next(err) : res.redirect(url)));
  } catch (e) { next(e); }
});

router.get('/callback', async (req, res, next) => {
  try {
    const params = client.callbackParams(req);
    const codeVerifier = req.session.codeVerifier;
    delete req.session.codeVerifier;

    const tokenSet = await client.callback(`${BACKEND_URL}/auth/callback`, params, {
      code_verifier: codeVerifier,
    });

    const claims = tokenSet.claims();
    const ns = process.env.AUTH0_ROLE_NAMESPACE || 'https://sellerdisclosuredev.app/';
    const roles = claims[`${ns}roles`] || [];

    req.session.user = { sub: claims.sub, email: claims.email, name: claims.name, roles };
    req.session.save(err => (err ? next(err) : res.redirect(FRONTEND_URL))); // <— go to React
  } catch (e) { next(e); }
});

// GET logout that redirects to Auth0 then back to FRONTEND_URL
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    const returnTo = encodeURIComponent(FRONTEND_URL);          // <— front end
    const url = `https://${process.env.AUTH0_DOMAIN}/v2/logout?client_id=${process.env.AUTH0_CLIENT_ID}&returnTo=${returnTo}`;
    res.redirect(url);
  });
});

module.exports = router;
