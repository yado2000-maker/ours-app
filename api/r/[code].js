export default function handler(req, res) {
  const { code } = req.query;
  if (!code || !/^[A-Za-z0-9]{4,8}$/.test(code)) {
    return res.redirect(302, "https://sheli.ai");
  }
  const waUrl = `https://wa.me/972555175553?text=${encodeURIComponent("\u05E9\u05DC\u05D5\u05DD " + code)}`;
  return res.redirect(302, waUrl);
}
