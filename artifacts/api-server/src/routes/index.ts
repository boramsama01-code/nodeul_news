import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";
import crawlRouter from "./crawl";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);
router.use(crawlRouter);
router.use(statsRouter);

export default router;
