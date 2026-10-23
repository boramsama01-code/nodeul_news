import { RelevanceReview } from "@/components/relevance-review";
import React, { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useStartCrawl,
  useStartBulkCrawl,
  useGetCrawlStatus,
  getGetCrawlStatusQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DownloadCloud, CheckCircle2, Clock, Info, Rss, Globe, CalendarRange, Search, AlertCircle, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ADMIN_REQUIRED_MESSAGE, ensureAuthorized, isAdminRequired } from "@/lib/admin";

interface RecentJob { id: string; status: string; collected: number; duplicates: number; error: string; createdAt: string; }
interface SourceFeed { endpoint: string; kind?: string | null; status: string; reason: string; itemCount: number; newest?: string; oldest?: string }
interface SourceHealth {
  checkedAt: string | null;
  summary?: { publishers: number; feeds: number; normal: number; partial: number; unsupported: number };
  sources: { name: string; domain: string; method: string; status: string; reason: string; endpoint?: string; scope?: "whole" | "section"; feedCount?: number; usableFeeds?: number; itemCount?: number; newest?: string; oldest?: string; feeds?: SourceFeed[] }[];
}
const sourceReasons: Record<string,string> = {official_feed_available:"공식 피드 정상 응답 · 최신 기사 범위 내 수집", advertised_news_sitemap:"공식 뉴스 사이트맵으로 보완 · 최근 기사 범위만 지원", recovered_official_feed:"공식 페이지에서 대체 피드를 발견해 복구", missing_publication_dates:"발행일 누락 · 기간 판정이 어려워 포털 검색으로 보완", sitemap_found_without_titles_and_publication_dates:"사이트맵은 있으나 기사 제목·발행일이 없어 직접 수집 제한", no_usable_official_feed:"제한된 점검 안에서 사용 가능한 공식 피드를 찾지 못함", legacy_report_without_support_level:"이전 점검 결과라 지원 수준 미기록 · 다음 점검 후 확정"};
const supportLabel = (status: string) => status === "normal" ? "정상" : status === "partial" ? "부분지원" : "미지원 / 현재 확인 실패";
const kstDate = (value?: string) => value ? new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "";
function describeSourceReason(reason: string): string {
  const section = /^section_feeds:(\d+)\/(\d+)$/.exec(reason);
  if (section) return `섹션별 피드 ${section[2]}개 중 ${section[1]}개 사용 가능 · 섹션 피드에 없는 기사는 포털 검색으로 보완`;
  return sourceReasons[reason] || reason;
}

type JobMode = "manual" | "bulk";

function getCrawlStartErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (isAdminRequired(error)) return ADMIN_REQUIRED_MESSAGE;
  if (message.includes("HTTP 400")) return message.replace(/^HTTP 400[^:]*:\s*/, "");
  if (message.includes("HTTP 503") && message.includes("재시작")) return "서버가 재시작 중입니다. 잠시 후 다시 시도해 주세요.";
  if (message.includes("수집 작업 저장소가 준비되지 않았습니다")) {
    return "배포 데이터베이스가 최신 상태가 아닙니다. 앱을 다시 게시해 데이터베이스 스키마를 동기화해 주세요.";
  }
  if (message.includes("HTTP 5")) {
    return "서버에서 수집 작업을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

export default function Crawl() {
  const { toast } = useToast();
  const {data:providerHealth}=useQuery<Record<string,{status:string;reason:string;checkedAt:string;blockedUntil?:string}>>({queryKey:['provider-health'],queryFn:async()=>{const r=await fetch('/api/crawl/provider-health');if(!r.ok)throw new Error('연결 상태 조회 실패');return r.json();}});
  const { data: sourceHealth } = useQuery<SourceHealth>({
    queryKey: ["source-health"],
    queryFn: async () => {
      const response = await fetch("/api/crawl/source-health");
      if (!response.ok) throw new Error("소스 점검 결과 조회 실패");
      return response.json();
    },
    staleTime: 60_000,
  });
  const queryClient = useQueryClient();
  const { data: configuration } = useQuery<{
    crawlIntervalMinutes: number;
    deployment?: { cloud: boolean; trial: boolean; schedulerEnabled: boolean };
  }>({
    queryKey: ["settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error("수집 설정 조회 실패");
      return response.json();
    },
  });
  const manualCloud = configuration?.deployment?.cloud === true && !configuration.deployment.schedulerEnabled;

  const { data: recentJobs, isError: historyError, refetch: refreshHistory } = useQuery<RecentJob[]>({
    queryKey: ["crawl-recent"],
    queryFn: async () => {
      const response = await fetch("/api/crawl/recent");
      if (!response.ok) throw new Error("수집 이력 조회 실패");
      return response.json();
    },
  });

  const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const yearStart = `${todayKst.slice(0, 4)}-01-01`;
  const [startDate, setStartDate] = useState(yearStart);
  const [endDate, setEndDate] = useState(todayKst);
  const [bulkStartDate, setBulkStartDate] = useState(yearStart);
  const [bulkEndDate, setBulkEndDate] = useState(todayKst);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<JobMode>("manual");
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [finalStats, setFinalStats] = useState<{ collected: number; duplicates: number; total: number } | null>(null);

  const startCrawl = useStartCrawl();
  const startBulkCrawl = useStartBulkCrawl();

  const { data: jobStatus } = useGetCrawlStatus(activeJobId || "", {
    query: {
      enabled: !!activeJobId,
      queryKey: getGetCrawlStatusQueryKey(activeJobId || ""),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "running" || status === "pending" ? 2000 : false;
      },
    },
  });

  useEffect(() => {
    if (jobStatus?.status === "done") {
      setFinalStats({
        collected: jobStatus.collected,
        duplicates: jobStatus.duplicates,
        total: jobStatus.total,
      });
      toast({
        title: "수집 작업 종료",
        description: `신규 수집 ${jobStatus.collected}건 · 중복 제외 ${jobStatus.duplicates}건`,
      });
      setShowCompletionModal(true);
      setActiveJobId(null);
      void queryClient.invalidateQueries();
    } else if (jobStatus?.status === "partial" || jobStatus?.status === "interrupted") {
      toast({
        title: jobStatus.status === "partial" ? "일부 구간 미확인" : "수집 중단",
        description: `신규 ${jobStatus.collected}건 저장. 차단·상한·대기 구간은 재수집이 필요합니다. 상세 기록을 확인하세요.`,
        variant: "destructive",
      });
      setActiveJobId(null);
      void queryClient.invalidateQueries();
    } else if (jobStatus?.status === "error") {
      toast({
        title: "수집 실패",
        description: jobStatus.error || "알 수 없는 오류가 발생했습니다.",
        variant: "destructive",
      });
      setActiveJobId(null);
      void queryClient.invalidateQueries();
    }
  }, [jobStatus?.status, toast, queryClient]);

  const [alternativePending,setAlternativePending]=useState(false);
  const handleAlternative=async()=>{
    if(!startDate||!endDate)return;setAlternativePending(true);setFinalStats(null);setActiveMode('manual');
    try{const r=await fetch('/api/crawl/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({startDate,endDate,alternative:true})});ensureAuthorized(r);const data=await r.json();if(!r.ok)throw new Error(data.error||'수집 시작 실패');setActiveJobId(data.jobId);toast({title:'구글 제외 보완 시작',description:'매일경제·서울신문 자체 검색과 다음 검색을 대조합니다.'});}catch(error){toast({title:'보완 시작 실패',description:String(error),variant:'destructive'});}finally{setAlternativePending(false);}
  };
  const handleStartCrawl = () => {
    if (!startDate || !endDate) return;
    setFinalStats(null);
    setActiveMode("manual");
    startCrawl.mutate(
      { data: { startDate, endDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          void queryClient.invalidateQueries();
          toast({ title: "수집 시작", description: "등록된 검색·RSS 수집처를 확인합니다. 실패 내역은 수집 이력에 표시됩니다." });
        },
        onError: (error) => {
          toast({ title: "수집 시작 실패", description: getCrawlStartErrorMessage(error), variant: "destructive" });
        },
      },
    );
  };

  const handleStartBulkCrawl = () => {
    if (!bulkStartDate || !bulkEndDate) return;
    setFinalStats(null);
    setActiveMode("bulk");
    startBulkCrawl.mutate(
      { data: { startDate: bulkStartDate, endDate: bulkEndDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          void queryClient.invalidateQueries();
          toast({ title: "대량 수집 시작", description: "월별로 나눠 순차 수집합니다. 시간이 걸릴 수 있습니다." });
        },
        onError: (error) => {
          toast({ title: "수집 시작 실패", description: getCrawlStartErrorMessage(error), variant: "destructive" });
        },
      },
    );
  };

  const isRunning = alternativePending || activeJobId !== null || startCrawl.isPending || startBulkCrawl.isPending;
  const currentSource = jobStatus?.currentSource || "";

  function getBulkMonthCount(): number {
    if (!bulkStartDate || !bulkEndDate) return 0;
    const s = new Date(bulkStartDate);
    const e = new Date(bulkEndDate);
    return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
  }

  const bulkMonthCount = getBulkMonthCount();

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">데이터 수집</h2>
        <p className="text-sm text-muted-foreground mt-0.5">네이버 API · 다음 웹 검색 · 구글뉴스 · 언론사 RSS에서 관련 기사를 수집합니다.</p>
      </div>

      <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-accent/60 border border-accent text-accent-foreground text-sm">
        <Clock className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-medium">{manualCloud ? "버튼을 눌러 수집" : "수집 방식"}</span>
          <span className="text-muted-foreground ml-1.5">— {manualCloud
            ? "날짜를 선택하고 아래 수집 버튼을 누를 때만 실행합니다. 접속하거나 서버가 깨어날 때 자동으로 수집하지 않습니다. 긴 수집은 이 화면을 열어두고 완료를 확인해 주세요."
            : configuration
              ? `자동 수집 프로그램이 실행 중일 때는 ${configuration.crawlIntervalMinutes}분 간격으로 최근 기간을 확인합니다. 아래 이력에서 실제 실행 여부를 확인하세요.`
              : "설정 화면에서 자동 수집 여부를 확인할 수 있습니다. 아래 버튼으로 필요한 기간을 직접 수집할 수 있습니다."}</span>
        </div>
      </div>


      <Card>
        <CardHeader><CardTitle>최근 수집 이력</CardTitle><CardDescription>신규 0건과 수집처 오류를 구분해 확인할 수 있습니다.</CardDescription>
          <Button variant="outline" size="sm" className="self-start" onClick={() => void refreshHistory()}>이력 새로고침</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {historyError && <p role="alert">수집 이력을 불러오지 못했습니다. 서버 연결을 확인하세요.</p>}
          {recentJobs?.length === 0 && <p className="text-sm text-muted-foreground">아직 실행 이력이 없습니다. 아래에서 기간을 선택해 수집을 시작하세요.</p>}
          {recentJobs?.map(job => <details key={job.id} className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer">{new Date(job.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · {job.status === "done" ? "완료" : job.status === "partial" ? "일부 미확인" : job.status === "interrupted" ? "중단됨" : job.status === "error" ? "오류" : "수집 중"} · 신규 {job.collected}건 / 중복 {job.duplicates}건</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{job.error || "실행 중이거나 상세 진단이 없는 이전 작업입니다."}</p>
          </details>)}
        </CardContent>
      </Card>

      <RelevanceReview disabled={isRunning} onRetry={async () => {
        try {
          const response = await fetch('/api/crawl/start', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({startDate, endDate, reviewOnly: true})});
          ensureAuthorized(response);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '재확인 시작 실패');
          setActiveMode('manual'); setActiveJobId(result.jobId);
          toast({title: '대기 후보 재확인 시작', description: '선택한 기간의 재시도 가능한 후보를 확인합니다.'});
        } catch (error) { toast({title: '재확인 시작 실패', description: error instanceof Error ? error.message : String(error), variant: 'destructive'}); }
      }} />
      {providerHealth && Object.keys(providerHealth).length>0 && <Card><CardHeader><CardTitle>검색 수집처 연결 상태</CardTitle><CardDescription>실제 응답으로 확인한 최근 상태입니다. 요청 휴식 종료는 서비스의 제한 해제를 보장하지 않습니다.</CardDescription></CardHeader><CardContent className="space-y-3">{Object.entries(providerHealth).map(([key,state])=><div key={key}><strong>{key==='google_news'?'구글뉴스':key==='naver_web'?'네이버 뉴스':key==='daum_web'?'다음 뉴스':key==='archive_mk'?'매일경제 자체검색':key==='archive_seoul'?'서울신문 자체검색':key}</strong> · {state.status==='ok'?'정상':state.status==='limited'?'접근 제한':'확인 필요'}<p>{state.reason}</p><p className="text-sm text-muted-foreground">확인: {new Date(state.checkedAt).toLocaleString('ko-KR')}{state.blockedUntil && Date.parse(state.blockedUntil)>Date.now() && <> · 앱 요청 휴식: {new Date(state.blockedUntil).toLocaleString('ko-KR')}까지</>}</p></div>)}</CardContent></Card>}
      {sourceHealth?.checkedAt && sourceHealth.sources.length > 0 && <Card>
        <CardHeader>
          <CardTitle>언론사 원문 소스 점검</CardTitle>
          <CardDescription>{new Date(sourceHealth.checkedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} 기준 · 아래 상태는 직접 수집 지원 여부입니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">RSS에 검색 기간의 기사가 없더라도 원문 사이트에 기사가 없다는 뜻은 아닙니다. 최신 RSS·Atom·뉴스 사이트맵과 포털 검색의 보관 범위가 다릅니다. 포털로 발견한 기사는 원문 링크와 언론사명을 확인하며 수집 경로는 그대로 표시합니다.</p>
          {sourceHealth.summary && <p>언론사 {sourceHealth.summary.publishers}곳(피드 {sourceHealth.summary.feeds}개) · 정상 {sourceHealth.summary.normal} · 부분지원 {sourceHealth.summary.partial} · 미지원 {sourceHealth.summary.unsupported}</p>}
          <details><summary className="cursor-pointer font-medium">언론사 {sourceHealth.sources.length}곳 상태 보기</summary>
            <div className="mt-3 max-h-96 overflow-auto divide-y">
              {sourceHealth.sources.map((source, index) => <div key={`${source.domain}-${index}`} className="py-3 space-y-1">
                <p className="font-medium">{source.name} · {supportLabel(source.status)}{source.scope === "section" ? ` · 섹션 피드 ${source.feedCount}개` : ""}</p>
                <p className="text-muted-foreground break-words">{describeSourceReason(source.reason)}</p>
                {(source.oldest || source.newest) && <p className="text-muted-foreground">피드에 남아 있는 기사 발행일: {kstDate(source.oldest)} ~ {kstDate(source.newest)} · 이 범위 밖 기간은 직접 수집할 수 없습니다.</p>}
                {source.endpoint && /^https?:\/\//.test(source.endpoint) && <a href={source.endpoint} target="_blank" rel="noreferrer" className="underline break-all">확인한 소스 열기</a>}
              </div>)}
            </div>
          </details>
        </CardContent>
      </Card>}

      {/* Manual crawl */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DownloadCloud className="w-5 h-5" />
            수동 수집
          </CardTitle>
          <CardDescription>특정 날짜 범위의 기사를 즉시 수집합니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">시작일</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={isRunning} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">종료일</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={isRunning} />
            </div>
          </div>

          <Button className="w-full h-11 text-base" onClick={handleStartCrawl} disabled={isRunning || !startDate || !endDate}>
            {isRunning && activeMode === "manual" ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                수집 중...
              </span>
            ) : "크롤링 실행"}
          </Button>

          <Button className="w-full" variant="outline" onClick={handleAlternative} disabled={isRunning || !startDate || !endDate}>구글 없이 과거 기사 보완</Button>
          <p className="text-xs text-muted-foreground">위 기간의 매일경제·서울신문 자체 검색과 다음 검색을 대조합니다. 같은 수집 경로와 URL이 모두 일치할 때만 중복 제외하며, 다른 언론사 전체의 수집을 보장하지는 않습니다.</p>
          {isRunning && activeMode === "manual" && jobStatus && (
            <div className="space-y-4 p-4 rounded-lg bg-muted/40 border">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-muted-foreground">진행률</span>
                  <span className="font-bold">{jobStatus.progress}%</span>
                </div>
                <Progress value={jobStatus.progress} className="h-2" />
                {currentSource && (
                  <p className="text-xs text-muted-foreground text-center">{currentSource}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 bg-background rounded-md border">
                  <div className="text-xs text-muted-foreground mb-1">신규 수집</div>
                  <div className="text-xl font-bold text-primary">{jobStatus.collected}건</div>
                </div>
                <div className="text-center p-3 bg-background rounded-md border">
                  <div className="text-xs text-muted-foreground mb-1">중복 제외</div>
                  <div className="text-xl font-bold">{jobStatus.duplicates}건</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bulk crawl */}
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="w-5 h-5" />
            전체 기간 대량 수집
            <Badge variant="secondary" className="ml-1 text-xs">네이버 API 누락 보완</Badge>
          </CardTitle>
          <CardDescription>
            네이버 API는 검색어당 최신 1,000건까지만 조회하므로 오래된 기사가 누락될 수 있습니다.
            월별로 나눠 순차 수집하여 더 많은 기사를 확보합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              기간이 길수록 시간이 오래 걸립니다. 백그라운드에서 실행되며 페이지를 닫아도 수집은 계속됩니다.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">시작일</label>
              <Input type="date" value={bulkStartDate} onChange={(e) => setBulkStartDate(e.target.value)} disabled={isRunning} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">종료일</label>
              <Input type="date" value={bulkEndDate} onChange={(e) => setBulkEndDate(e.target.value)} disabled={isRunning} />
            </div>
          </div>

          {bulkMonthCount > 0 && (
            <p className="text-xs text-muted-foreground text-center">
              총 <span className="font-semibold text-foreground">{bulkMonthCount}개월</span> 분량을 월별로 분할 수집합니다
            </p>
          )}

          <Button
            className="w-full h-11 text-base"
            variant="default"
            onClick={handleStartBulkCrawl}
            disabled={isRunning || !bulkStartDate || !bulkEndDate || bulkMonthCount < 1}
          >
            {isRunning && activeMode === "bulk" ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                월별 수집 중...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CalendarRange className="w-4 h-4" />
                전체 기간 대량 수집 실행
              </span>
            )}
          </Button>

          {isRunning && activeMode === "bulk" && jobStatus && (
            <div className="space-y-4 p-4 rounded-lg bg-muted/40 border">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-muted-foreground">전체 진행률</span>
                  <span className="font-bold">{jobStatus.progress}%</span>
                </div>
                <Progress value={jobStatus.progress} className="h-2" />
                {currentSource && (
                  <p className="text-xs text-muted-foreground text-center">{currentSource}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 bg-background rounded-md border">
                  <div className="text-xs text-muted-foreground mb-1">신규 수집</div>
                  <div className="text-xl font-bold text-primary">{jobStatus.collected}건</div>
                </div>
                <div className="text-center p-3 bg-background rounded-md border">
                  <div className="text-xs text-muted-foreground mb-1">중복 제외</div>
                  <div className="text-xl font-bold">{jobStatus.duplicates}건</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Source info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Info className="w-4 h-4" />
            수집 채널 안내
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {/* Naver API */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Search className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">네이버 뉴스 API</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">API</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0">실행 이력에서 확인</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  "노들섬", "예술섬노들", "글로벌 노들 예술섬", "노들 글로벌 예술섬"을 각각 검색합니다. 검색어당 최대 1,000건이며 과거 전체 기사 조회는 보장되지 않습니다.
                </div>
              </div>
            </div>
            {/* Daum API */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Search className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">다음 뉴스 웹 검색</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">API</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0">API 키 불필요</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  다음 검색 결과에서 기사를 추출합니다. 카카오 API 키는 사용하지 않습니다. 페이지 구조 변경이나 차단 시 진단 이력에 표시됩니다.
                </div>
              </div>
            </div>
            {/* RSS Direct */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Rss className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">언론사 RSS 직접 수집</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">RSS</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0">실행 이력에서 확인</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  전국 주요 언론사의 RSS를 수집하고, 제목·본문 요약에 지정 키워드 중 하나가 있는 기사만 저장합니다. "노들길"·"노들로" 등만 있는 기사는 제외합니다. RSS는 최신 기사만 제공하므로 오래된 기사는 누락될 수 있습니다.
                </div>
              </div>
            </div>
            {/* Google News RSS */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Globe className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">구글뉴스 RSS 검색</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">RSS</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0">실행 이력에서 확인</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  지역지·전문지 등 자체 RSS가 없는 매체를 Google News RSS(site: 연산자)로 수집. 검색 기간을 지정하며, 직접 RSS가 실패한 매체의 보완 검색에도 사용합니다.
                </div>
              </div>
            </div>
          </div>
          <div className="px-4 py-3 border-t bg-muted/30">
            <p className="text-xs text-muted-foreground">
              <strong>감성 분석</strong>: 크롤 수집 시 rule-based 방식으로 자동 판단됩니다. 기사 목록에서 개별 수동 조정이 가능합니다.
            </p>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showCompletionModal} onOpenChange={setShowCompletionModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              수집 작업 종료
            </DialogTitle>
            <DialogDescription>조회한 기사의 처리가 끝났습니다. 최근 수집 기록에서 실패한 출처와 검색 제한을 확인해 주세요.</DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-2">
            <div className="flex justify-between items-center p-3 bg-muted rounded-lg">
              <span className="text-sm">처리된 기사 (신규 + 중복)</span>
              <span className="font-bold">{(finalStats?.total ?? 0).toLocaleString()}건</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-primary/8 text-primary rounded-lg border border-primary/15">
              <span className="text-sm font-medium">신규 수집 기사</span>
              <span className="font-bold text-lg">{(finalStats?.collected ?? 0).toLocaleString()}건</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-muted/60 rounded-lg">
              <span className="text-sm text-muted-foreground">중복으로 제외된 기사</span>
              <span className="font-medium">{(finalStats?.duplicates ?? 0).toLocaleString()}건</span>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowCompletionModal(false)}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
