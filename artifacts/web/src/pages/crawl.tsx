import React, { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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

interface SettingsResponse {
  kakaoApiKey: { configured: boolean; masked: string | null };
}

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("설정 조회 실패");
  return res.json() as Promise<SettingsResponse>;
}

type JobMode = "manual" | "bulk";

export default function Crawl() {
  const { toast } = useToast();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
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
    } else if (jobStatus?.status === "error") {
      toast({
        title: "수집 실패",
        description: jobStatus.error || "알 수 없는 오류가 발생했습니다.",
        variant: "destructive",
      });
      setActiveJobId(null);
    }
  }, [jobStatus?.status, toast]);

  const handleStartCrawl = () => {
    if (!startDate || !endDate) return;
    setFinalStats(null);
    setActiveMode("manual");
    startCrawl.mutate(
      { data: { startDate, endDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          toast({ title: "수집 시작", description: "137개 언론사에서 병렬로 수집을 시작합니다." });
        },
        onError: () => {
          toast({ title: "수집 시작 실패", description: "서버 연결에 실패했습니다.", variant: "destructive" });
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
          toast({ title: "대량 수집 시작", description: "월별로 나눠 순차 수집합니다. 시간이 걸릴 수 있습니다." });
        },
        onError: () => {
          toast({ title: "수집 시작 실패", description: "서버 연결에 실패했습니다.", variant: "destructive" });
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
        <p className="text-sm text-muted-foreground mt-0.5">네이버 API · 다음 API · 137개 언론사 RSS에서 노들섬 관련 기사를 병렬 수집합니다 · 매일 자정 자동 수집</p>
      </div>

      <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-accent/60 border border-accent text-accent-foreground text-sm">
        <Clock className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-medium">자동 수집 활성화</span>
          <span className="text-muted-foreground ml-1.5">— 매일 자정(KST 00:00)에 전날 기사를 자동으로 수집합니다. 수동 수집은 특정 기간이 필요할 때만 사용하세요.</span>
        </div>
      </div>

      {settings && !settings.kakaoApiKey.configured && (
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-medium">다음(카카오) API 키 미설정</span>
            <span className="text-amber-700 dark:text-amber-400 ml-1.5">— 현재 네이버 API + RSS만 수집됩니다. 다음뉴스도 수집하려면 카카오 REST API 키를 등록하세요.</span>
          </div>
          <Link href="/settings">
            <Button variant="outline" size="sm" className="shrink-0 h-7 text-xs gap-1 border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300">
              <Settings className="w-3 h-3" />
              설정
            </Button>
          </Link>
        </div>
      )}

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
            네이버 API는 페이지당 100건 제한으로 오래된 기사가 누락될 수 있습니다.
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
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-green-600 border-green-300">연결됨</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  네이버 검색 API로 "노들" 키워드 뉴스를 월별로 분할 수집. 최대 1,000건/월 수집하며 중복 제거 처리됨.
                </div>
              </div>
            </div>
            {/* Daum API */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Search className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">다음 뉴스 API (카카오)</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">API</Badge>
                  {settings?.kakaoApiKey.configured ? (
                    <Badge variant="outline" className="text-xs px-1.5 py-0 text-green-600 border-green-300">연결됨</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs px-1.5 py-0 text-orange-500 border-orange-300">키 미설정</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  카카오 검색 API(dapi.kakao.com)로 "노들" 키워드 뉴스를 페이지별 수집. 페이지당 50건, 최대 2,500건 수집 가능.
                  {!settings?.kakaoApiKey.configured && (
                    <Link href="/settings">
                      <span className="ml-1 text-amber-600 underline cursor-pointer">설정에서 REST API 키 등록 →</span>
                    </Link>
                  )}
                </div>
              </div>
            </div>
            {/* RSS Direct */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Rss className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">RSS 직접 수집 (63개 매체)</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">RSS</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-green-600 border-green-300">연결됨</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  연합뉴스, 조선·중앙·동아·한겨레 등 전국 주요 언론사 RSS 피드를 직접 구독. 수집 후 "노들섬" 키워드 필터링 적용.
                </div>
              </div>
            </div>
            {/* Google News RSS */}
            <div className="px-4 py-4 flex items-start gap-3">
              <Globe className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">구글뉴스 RSS (74개 매체)</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">RSS</Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-green-600 border-green-300">연결됨</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  지역지·전문지 등 자체 RSS가 없는 매체를 Google News RSS(site: 연산자)로 수집. 검색 단계에서 이미 "노들섬" 키워드 필터됨.
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
