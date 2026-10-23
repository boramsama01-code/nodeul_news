import express, { Router, type IRouter } from "express";
import { importArticleUrls, importBigKindsWorkbook, type ImportSummary } from "../lib/manualImports";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function compact(summary: ImportSummary, limit = 200) {
  return {
    ...summary,
    results: summary.results.slice(0, limit),
    resultsTruncated: Math.max(0, summary.results.length - limit),
  };
}

router.post("/articles/import-urls", async (req, res): Promise<void> => {
  const text = req.body?.urls;
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "기사 URL을 한 줄에 하나씩 입력해 주세요." });
    return;
  }
  try {
    res.json(compact(await importArticleUrls(text), 100));
  } catch (error) {
    logger.error({ error }, "Manual URL import failed");
    res.status(400).json({ error: error instanceof Error ? error.message : "URL 가져오기에 실패했습니다." });
  }
});

const xlsxBody = express.raw({
  type: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
  limit: "25mb",
});

router.post("/articles/import-bigkinds", xlsxBody, async (req, res): Promise<void> => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "빅카인즈에서 내려받은 .xlsx 파일을 선택해 주세요." });
    return;
  }
  try {
    res.json(compact(await importBigKindsWorkbook(req.body), 200));
  } catch (error) {
    logger.error({ error }, "BigKinds workbook import failed");
    res.status(400).json({ error: error instanceof Error ? error.message : "빅카인즈 파일을 가져오지 못했습니다." });
  }
});

export default router;
