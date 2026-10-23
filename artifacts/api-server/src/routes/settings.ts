import { Router, type IRouter } from "express";
import { setKakaoApiKey, deleteKakaoApiKey, isKakaoApiKeySet } from "../lib/configStore";
import { logger } from "../lib/logger";
import axios from "axios";
import { setNaverKeys } from "../lib/configStore";

const router: IRouter = Router();
router.post("/settings/naver-key", async (req, res): Promise<void> => {
  const { clientId, clientSecret } = req.body ?? {};
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId.trim() || !clientSecret.trim() || clientId.length > 512 || clientSecret.length > 512) {
    res.status(400).json({ error: "Client ID와 Client Secret을 모두 입력해 주세요." }); return;
  }
  await setNaverKeys(clientId.trim(), clientSecret.trim());
  res.json({ ok: true });
});

// GET /api/settings — returns current config status (never exposes keys)
router.get("/settings", (_req, res): void => {
  const kakaoSet = isKakaoApiKeySet();
  res.json({
    naverApi: { configured: !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET) },
    ai: { configured: !!process.env.ANTHROPIC_API_KEY },
    deployment: {
      cloud: process.env.STATE_BACKEND === "postgres",
      trial: process.env.DEPLOYMENT_MODE === "free-trial",
      databaseExpiresAt: process.env.DATABASE_EXPIRES_AT || null,
      schedulerEnabled: process.env.RUN_SCHEDULER === "true",
      revision: process.env.RENDER_GIT_COMMIT || null,
    },
    crawlIntervalMinutes: Number(process.env.CRAWL_INTERVAL_MINUTES || 30),
    kakaoApiKey: {
      configured: kakaoSet,
      masked: null,
    },
  });
});

// POST /api/settings/kakao-key — save & validate Kakao REST API key
router.post("/settings/kakao-key", async (req, res): Promise<void> => {
  const { key } = req.body as { key?: string };
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    res.status(400).json({ error: "키를 입력해 주세요." });
    return;
  }

  const trimmedKey = key.trim();

  // Quick validation — call Kakao API with the key
  try {
    await axios.get("https://dapi.kakao.com/v2/search/web", {
      headers: { Authorization: `KakaoAK ${trimmedKey}` },
      params: { query: "노들", size: 1 },
      timeout: 8000,
    });
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      res.status(400).json({ error: "유효하지 않은 REST API 키입니다. 카카오 개발자 콘솔에서 확인해 주세요." });
      return;
    }
    // Network error etc — still save, might be transient
    logger.warn({ status }, "Kakao key validation request failed (non-auth), saving anyway");
  }

  await setKakaoApiKey(trimmedKey);
  logger.info("Kakao REST API key updated");

  res.json({ ok: true, masked: `${trimmedKey.slice(0, 4)}${"*".repeat(Math.max(0, trimmedKey.length - 4))}` });
});

// DELETE /api/settings/kakao-key — remove saved key
router.delete("/settings/kakao-key", async (_req, res): Promise<void> => {
  await deleteKakaoApiKey();
  logger.info("Kakao REST API key removed");
  res.json({ ok: true });
});

export default router;
