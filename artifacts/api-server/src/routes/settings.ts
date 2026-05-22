import { Router, type IRouter } from "express";
import { getKakaoApiKey, setKakaoApiKey, deleteKakaoApiKey, isKakaoApiKeySet } from "../lib/configStore";
import { logger } from "../lib/logger";
import axios from "axios";

const router: IRouter = Router();

// GET /api/settings — returns current config status (never exposes keys)
router.get("/settings", (_req, res): void => {
  const kakaoSet = isKakaoApiKeySet();
  const kakaoKey = getKakaoApiKey();
  res.json({
    kakaoApiKey: {
      configured: kakaoSet,
      masked: kakaoSet && kakaoKey ? `${kakaoKey.slice(0, 4)}${"*".repeat(Math.max(0, kakaoKey.length - 4))}` : null,
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
    await axios.get("https://dapi.kakao.com/v2/search/news", {
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

  setKakaoApiKey(trimmedKey);
  logger.info("Kakao REST API key updated");

  res.json({ ok: true, masked: `${trimmedKey.slice(0, 4)}${"*".repeat(Math.max(0, trimmedKey.length - 4))}` });
});

// DELETE /api/settings/kakao-key — remove saved key
router.delete("/settings/kakao-key", (_req, res): void => {
  deleteKakaoApiKey();
  logger.info("Kakao REST API key removed");
  res.json({ ok: true });
});

export default router;
