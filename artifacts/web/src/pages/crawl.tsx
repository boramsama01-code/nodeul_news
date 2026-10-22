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

interface RecentJob { id: string; status: string; collected: number; duplicates: number; error: string; createdAt: string; }

type JobMode = "manual" | "bulk";

function getCrawlStartErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
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

  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);

  const [startDate, setStartDate] = useState(lastWeek.toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState(today.toISOString().split("T")[0]);

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(today.getFullYear() - 5);
  const [bulkStartDate, setBulkStartDate] = useState(fiveYearsAgo.toISOString().split("T")[0]);
  const [bulkEndDate, setBulkEndDate] = useState(today.toISOString().split("T")[0]);

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
        title: "수집 완료",
        description: `신규 수집 ${jobStatus.collected}건 · 중복 제외 ${jobStatus.duplicates}건`,
      });
      setShowCompletionModal(true);
      setActiveJobId(null);
      void queryClient.invalidateQueries({ queryKey: ["crawl-recent"] });
    } else if (jobStatus?.status === "error") {
      toast({
        title: "수집 실패",
        description: jobStatus.error || "알 수 없는 오류가 발생했습니다.",
        variant: "destructive",
      });
      setActiveJobId(null);
      void queryClient.invalidateQueries({ queryKey: ["crawl-recent"] });
    }
  }, [jobStatus?.status, toast, queryClient]);

  const handleStartCrawl = () => {
    if (!startDate || !endDate) return;
    setFinalStats(null);
    setActiveMode("manual");
    startCrawl.mutate(
      { data: { startDate, endDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          void queryClient.invalidateQueries({ queryKey: ["crawl-recent"] });
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
          void queryClient.invalidateQueries({ queryKey: ["crawl-recent"] });
          toast({ title: "대량 수집 시작", description: "월별로 나눠 순차 수집합니다. 시간이 걸릴 수 있습니다." });
        },
        onError: (error) => {
          toast({ title: "수집 시작 실패", description: getCrawlStartErrorMessage(error), variant: "destructive" });
        },
      },
    );
  };

  const isRunning = activeJobId !== null || startCrawl.isPending || startBulkCrawl.isPending;
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
            <summary className="cursor-pointer">{new Date(job.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · {job.status === "done" ? "완료 (상세 확인)" : job.status === "error" ? "오류" : "수집 중"} · 신규 {job.collected}건 / 중복 {job.duplicates}건</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{job.error || "실행 중이거나 상세 진단이 없는 이전 작업입니다."}</p>
          </details>)}
        </CardContent>
      </Card>

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
              수집 완료
            </DialogTitle>
            <DialogDescription>지정 기간의 뉴스 수집이 완료되었습니다.</DialogDescription>
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
