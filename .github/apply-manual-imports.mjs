import { readFile, writeFile } from "node:fs/promises";

async function edit(path, changes) {
  let text = await readFile(path, "utf8");
  for (const [from, to, label] of changes) {
    if (!text.includes(from)) throw new Error(`${path}: missing transformation anchor: ${label}`);
    text = text.replace(from, to);
  }
  await writeFile(path, text);
}

await edit("artifacts/web/src/pages/articles.tsx", [
  [
    'import { Trash2, Plus, ChevronLeft, ChevronRight, Loader2, ExternalLink, Download } from "lucide-react";\n\nconst MONTHS',
    'import { Trash2, Plus, ChevronLeft, ChevronRight, Loader2, ExternalLink, Download } from "lucide-react";\nimport { ArticleImportPanel } from "@/components/article-import-panel";\n\nconst MONTHS',
    "article import component import",
  ],
  [
    '      {/* Filter Bar */}',
    '      <ArticleImportPanel onImported={invalidate} />\n\n      {/* Filter Bar */}',
    "article import panel",
  ],
  [
`                          <a
                            href={article.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary font-medium text-[13px] line-clamp-1 transition-colors flex items-center gap-1 group"
                          >
                            <span className="truncate">{article.title}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                          </a>`,
`                          {/^^https?:\\/\\//i.test(article.url) ? (
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-primary font-medium text-[13px] line-clamp-1 transition-colors flex items-center gap-1 group"
                            >
                              <span className="truncate">{article.title}</span>
                              <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                            </a>
                          ) : (
                            <div className="font-medium text-[13px] line-clamp-1" title={\`${article.title} · ${article.url}\`}>
                              {article.title}
                              <span className="ml-2 text-[10px] font-normal text-muted-foreground">빅카인즈 가져오기</span>
                            </div>
                          )}`.replace("{/^^", "{/^"),
    "non-http article rendering",
  ],
]);

await edit("artifacts/web/src/pages/crawl.tsx", [
  [
`interface SourceHealth {
  checkedAt: string | null;
  summary?: { publishers: number; feeds: number; normal: number; partial: number; unsupported: number };
  sources: { name: string; domain: string; method: string; status: string; reason: string; endpoint?: string; scope?: "whole" | "section"; feedCount?: number; usableFeeds?: number; itemCount?: number; newest?: string; oldest?: string; feeds?: SourceFeed[] }[];
}
const sourceReasons`,
`interface SourceHealth {
  checkedAt: string | null;
  summary?: { publishers: number; feeds: number; normal: number; partial: number; unsupported: number };
  sources: { name: string; domain: string; method: string; status: string; reason: string; endpoint?: string; scope?: "whole" | "section"; feedCount?: number; usableFeeds?: number; itemCount?: number; newest?: string; oldest?: string; feeds?: SourceFeed[] }[];
}
interface ProviderState { status: string; reason: string; checkedAt: string; blockedUntil?: string }
const providerLabel = (key: string) => key === "google_news" ? "구글뉴스"
  : key === "naver_api" ? "네이버 공식 API"
  : key === "naver_web" ? "네이버 뉴스 웹검색"
  : key === "daum_web" ? "다음 뉴스 웹검색"
  : key === "archive_mk" ? "매일경제 자체검색"
  : key === "archive_seoul" ? "서울신문 자체검색" : key;
function providerStatusLabel(key: string, state: ProviderState): string {
  if (state.status === "ok") return "정상";
  if (key === "naver_api" && state.status === "limited") return "공식 API 범위 일부 확인";
  return state.status === "limited" ? "접근 제한" : "확인 필요";
}
const sourceReasons`,
    "provider helpers",
  ],
  [
    "const {data:providerHealth}=useQuery<Record<string,{status:string;reason:string;checkedAt:string;blockedUntil?:string}>>",
    "const {data:providerHealth}=useQuery<Record<string,ProviderState>>",
    "provider query type",
  ],
  [
    '  const [finalStats, setFinalStats] = useState<{ collected: number; duplicates: number; total: number } | null>(null);',
    '  const [finalStats, setFinalStats] = useState<{ collected: number; duplicates: number; total: number } | null>(null);\n  const [probePending, setProbePending] = useState<string | null>(null);',
    "probe state",
  ],
  [
    '  const isRunning = alternativePending || activeJobId !== null || startCrawl.isPending || startBulkCrawl.isPending;',
`  const probeProvider = async (provider: "naver_web" | "daum_web") => {
    setProbePending(provider);
    try {
      const response = await fetch("/api/crawl/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      ensureAuthorized(response);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "접근 상태를 확인하지 못했습니다.");
      await queryClient.invalidateQueries({ queryKey: ["provider-health"] });
      toast({ title: result.ok ? "접근 가능" : "접근 제한 유지", description: result.reason, variant: result.ok ? "default" : "destructive" });
    } catch (error) {
      toast({ title: "접근 재확인 실패", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally { setProbePending(null); }
  };

  const isRunning = alternativePending || activeJobId !== null || startCrawl.isPending || startBulkCrawl.isPending;`,
    "probe handler",
  ],
  [
    '<p className="text-sm text-muted-foreground mt-0.5">네이버 API · 다음 웹 검색 · 구글뉴스 · 언론사 RSS에서 관련 기사를 수집합니다.</p>',
    '<p className="text-sm text-muted-foreground mt-0.5">네이버 공식 API · 포털 웹검색 · 구글뉴스 · 언론사 RSS를 함께 확인하고, 막힌 기간은 URL·빅카인즈 가져오기로 보완합니다.</p>',
    "crawl page intro",
  ],
  [
`      {providerHealth && Object.keys(providerHealth).length>0 && <Card><CardHeader><CardTitle>검색 수집처 연결 상태</CardTitle><CardDescription>실제 응답으로 확인한 최근 상태입니다. 요청 휴식 종료는 서비스의 제한 해제를 보장하지 않습니다.</CardDescription></CardHeader><CardContent className="space-y-3">{Object.entries(providerHealth).map(([key,state])=><div key={key}><strong>{key==='google_news'?'구글뉴스':key==='naver_web'?'네이버 뉴스':key==='daum_web'?'다음 뉴스':key==='archive_mk'?'매일경제 자체검색':key==='archive_seoul'?'서울신문 자체검색':key}</strong> · {state.status==='ok'?'정상':state.status==='limited'?'접근 제한':'확인 필요'}<p>{state.reason}</p><p className="text-sm text-muted-foreground">확인: {new Date(state.checkedAt).toLocaleString('ko-KR')}{state.blockedUntil && Date.parse(state.blockedUntil)>Date.now() && <> · 앱 요청 휴식: {new Date(state.blockedUntil).toLocaleString('ko-KR')}까지</>}</p></div>)}</CardContent></Card>}`,
`      {providerHealth && Object.keys(providerHealth).length>0 && <Card>
        <CardHeader>
          <CardTitle>검색 수집처 연결 상태</CardTitle>
          <CardDescription>실제 응답으로 확인한 최근 상태입니다. 휴식 종료는 제한 해제를 뜻하지 않으며, 재확인은 검색어 1개·1일·첫 페이지만 한 번 요청합니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(providerHealth).map(([key,state]) => {
            const cooling = !!state.blockedUntil && Date.parse(state.blockedUntil) > Date.now();
            const cooldownEnded = !!state.blockedUntil && !cooling && state.status !== "ok";
            const canProbe = key === "naver_web" || key === "daum_web";
            return <div key={key} className="space-y-1 border-b pb-3 last:border-b-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <strong>{providerLabel(key)} · {providerStatusLabel(key, state)}</strong>
                {canProbe && <Button size="sm" variant="outline" disabled={!!probePending || cooling} onClick={() => void probeProvider(key as "naver_web" | "daum_web")}>
                  {probePending === key ? "확인 중…" : cooling ? "요청 휴식 중" : "최소 요청으로 재확인"}
                </Button>}
              </div>
              <p>{state.reason}</p>
              <p className="text-sm text-muted-foreground">확인: {new Date(state.checkedAt).toLocaleString('ko-KR')}
                {cooling && <> · 앱 요청 휴식: {new Date(state.blockedUntil!).toLocaleString('ko-KR')}까지</>}
                {cooldownEnded && <> · 요청 휴식 종료 · 현재 접근 가능 여부는 재확인 전</>}
              </p>
            </div>;
          })}
        </CardContent>
      </Card>}`,
    "provider health card",
  ],
  [
    '<Badge variant="secondary" className="ml-1 text-xs">네이버 API 누락 보완</Badge>',
    '<Badge variant="secondary" className="ml-1 text-xs">공식 API + 월별 웹 보완</Badge>',
    "bulk badge",
  ],
  [
`            네이버 API는 검색어당 최신 1,000건까지만 조회하므로 오래된 기사가 누락될 수 있습니다.
            월별로 나눠 순차 수집하여 더 많은 기사를 확보합니다.`,
`            네이버 공식 API는 전체 기간에 한 번 조회해 날짜로 분류하고, 웹검색·RSS는 월별·주별로 나눠 순차 확인합니다. API가 목표 시작일까지 닿지 못하면 상태에 범위 일부 확인으로 표시합니다.`,
    "bulk description",
  ],
]);
