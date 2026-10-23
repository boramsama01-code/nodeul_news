import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";
import crawlRouter from "./crawl";
import statsRouter from "./stats";
import settingsRouter from "./settings";
import importsRouter from "./imports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);
router.use(crawlRouter);
router.use(statsRouter);
router.use(settingsRouter);
router.use(importsRouter);

export default router;
