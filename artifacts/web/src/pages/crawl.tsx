import React, { useState, useEffect } from "react";
import { useStartCrawl, useGetCrawlStatus, getGetCrawlStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DownloadCloud, CheckCircle2, Clock, Info } from "lucide-react";

const SOURCES = [
  { key: "네이버API", label: "네이버 뉴스 API", desc: "키워드 검색 (date+sim 정렬)" },
  { key: "구글RSS", label: "Google News RSS", desc: "노들섬/노들 키워드" },
  { key: "다음뉴스", label: "다음 뉴스 검색", desc: "날짜 범위 검색, 최대 30페이지" },
  { key: "BigKinds", label: "BigKinds 뉴스빅데이터", desc: "한국언론진흥재단 DB" },
  { key: "RSS피드들", label: "RSS 피드 (~40개 매체)", desc: "연합뉴스, 조선, 중앙 등 주요 언론사" },
  { key: "언론사검색", label: "언론사 직접 검색", desc: "개별 언론사 검색 기능 활용" },
  { key: "네이버검색", label: "네이버 모바일 검색", desc: "노들섬/노들 2 키워드 × 10페이지" },
];

export default function Crawl() {
  const { toast } = useToast();

  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);

  const [startDate, setStartDate] = useState(lastWeek.toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState(today.toISOString().split("T")[0]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [finalStats, setFinalStats] = useState<{ collected: number; duplicates: number; total: number } | null>(null);

  const startCrawl = useStartCrawl();

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
    startCrawl.mutate(
      { data: { startDate, endDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          toast({ title: "수집 시작", description: "백그라운드에서 데이터 수집을 시작합니다." });
        },
        onError: () => {
          toast({ title: "수집 시작 실패", description: "서버 연결에 실패했습니다.", variant: "destructive" });
        },
      },
    );
  };

  const isRunning = activeJobId !== null || startCrawl.isPending;
  const currentSource = jobStatus?.currentSource || "";

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">데이터 수집</h2>
        <p className="text-sm text-muted-foreground mt-0.5">노들섬 관련 기사를 7개 채널에서 수집합니다 · 매일 자정 자동 수집</p>
      </div>

      {/* Auto-crawl notice */}
      <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-accent/60 border border-accent text-accent-foreground text-sm">
        <Clock className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-medium">자동 수집 활성화</span>
          <span className="text-muted-foreground ml-1.5">— 매일 자정(KST 00:00)에 전날 기사를 자동으로 수집합니다. 수동 수집은 특정 기간이 필요할 때만 사용하세요.</span>
        </div>
      </div>

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
            {isRunning ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                수집 중...
              </span>
            ) : "크롤링 실행"}
          </Button>

          {isRunning && jobStatus && (
            <div className="space-y-4 p-4 rounded-lg bg-muted/40 border">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-muted-foreground">진행률</span>
                  <span className="font-bold">{jobStatus.progress}%</span>
                </div>
                <Progress value={jobStatus.progress} className="h-2" />
                {currentSource && (
                  <p className="text-xs text-muted-foreground text-center">현재: {currentSource}</p>
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
            {SOURCES.map((s) => {
              const isActive = isRunning && currentSource === s.key;
              return (
                <div key={s.key} className={`px-4 py-3 flex items-center gap-3 transition-colors ${isActive ? "bg-accent/40" : ""}`}>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${isActive ? "bg-primary animate-pulse" : "bg-border"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </div>
                  {isActive && <Badge className="text-xs bg-primary/10 text-primary border-primary/20">진행중</Badge>}
                </div>
              );
            })}
          </div>
          <div className="px-4 py-3 border-t bg-muted/30">
            <p className="text-xs text-muted-foreground">
              <strong>참고</strong>: RSS 피드는 연합뉴스, 조선일보, 중앙일보, 동아일보 등 약 40개 주요 언론사를 커버합니다.
              네이버·다음 검색은 포털에 등록된 전체 기사를 대상으로 수집합니다.
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
