import { Router, type IRouter } from "express";
import { checkPassword, clearSessionCookie, isAdminRequest, limitLogins, sessionCookie, setSessionCookie } from "../lib/adminAuth";

const router: IRouter = Router();

router.get("/admin/session", (req, res) => {
  res.json({ admin: isAdminRequest(req) });
});

router.post("/admin/session", limitLogins(), (req, res) => {
  if (!checkPassword(req.body?.password)) {
    res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
    return;
  }
  const value = sessionCookie();
  if (!value) { res.status(503).json({ error: "관리자 비밀번호가 서버에 설정되지 않았습니다." }); return; }
  setSessionCookie(res, value);
  res.json({ admin: true });
});

router.delete("/admin/session", (_req, res) => {
  clearSessionCookie(res);
  res.json({ admin: false });
});

export default router;
