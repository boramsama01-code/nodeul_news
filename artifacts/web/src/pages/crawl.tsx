import React, { useState, useEffect } from "react";
import { useStartCrawl, useGetCrawlStatus, getGetCrawlStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export default function Crawl() {
  const { toast } = useToast();
  
  // Date defaults to today to last 7 days
  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);
  
  const [startDate, setStartDate] = useState(lastWeek.toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(today.toISOString().split('T')[0]);
  
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  
  const startCrawl = useStartCrawl();
  
  const { data: jobStatus, refetch } = useGetCrawlStatus(activeJobId || "", {
    query: {
      enabled: !!activeJobId,
      queryKey: getGetCrawlStatusQueryKey(activeJobId || ""),
      refetchInterval: (query) => {
        if (query.state.data?.status === "running" || query.state.data?.status === "pending") {
          return 2000;
        }
        return false;
      }
    }
  });

  useEffect(() => {
    if (jobStatus?.status === "done") {
      toast({
        title: "수집 완료",
        description: `총 ${jobStatus.collected}건 수집 완료 (중복 제외: ${jobStatus.collected - jobStatus.duplicates}건)`,
      });
      setShowCompletionModal(true);
      setActiveJobId(null);
    } else if (jobStatus?.status === "error") {
      toast({
        title: "수집 실패",
        description: jobStatus.error || "알 수 없는 오류가 발생했습니다.",
        variant: "destructive"
      });
      setActiveJobId(null);
    }
  }, [jobStatus?.status, toast]);

  const handleStartCrawl = () => {
    if (!startDate || !endDate) return;
    
    startCrawl.mutate(
      { data: { startDate, endDate } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
          toast({
            title: "수집 시작",
            description: "데이터 수집 작업을 시작했습니다.",
          });
        },
        onError: () => {
          toast({
            title: "수집 시작 실패",
            description: "서버와의 통신에 실패했습니다.",
            variant: "destructive"
          });
        }
      }
    );
  };

  const isRunning = activeJobId !== null || startCrawl.isPending;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold tracking-tight">데이터 수집</h2>

      <Card>
        <CardHeader>
          <CardTitle>신규 데이터 크롤링</CardTitle>
          <CardDescription>
            지정된 기간 동안의 기사를 수집합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">시작일</label>
              <Input 
                type="date" 
                value={startDate} 
                onChange={(e) => setStartDate(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">종료일</label>
              <Input 
                type="date" 
                value={endDate} 
                onChange={(e) => setEndDate(e.target.value)}
                disabled={isRunning}
              />
            </div>
          </div>

          <Button 
            className="w-full h-12 text-lg" 
            onClick={handleStartCrawl} 
            disabled={isRunning || !startDate || !endDate}
          >
            {isRunning ? "수집 중..." : "크롤링 실행"}
          </Button>

          {isRunning && jobStatus && (
            <div className="bg-muted/50 p-6 rounded-lg space-y-4 border">
              <div className="flex justify-between items-center text-sm font-medium">
                <span>진행률</span>
                <span>{jobStatus.progress}%</span>
              </div>
              <Progress value={jobStatus.progress} className="h-2" />
              
              <div className="grid grid-cols-2 gap-4 text-center divide-x pt-2">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">전체 수집</div>
                  <div className="text-xl font-bold">{jobStatus.collected}건</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">중복 제외</div>
                  <div className="text-xl font-bold">{jobStatus.collected - jobStatus.duplicates}건</div>
                </div>
              </div>
              
              {jobStatus.currentSource && (
                <div className="text-xs text-center text-muted-foreground mt-4 truncate">
                  현재 처리중: {jobStatus.currentSource}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCompletionModal} onOpenChange={setShowCompletionModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>수집 완료</DialogTitle>
            <DialogDescription>
              지정된 기간의 뉴스 수집이 완료되었습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <div className="flex justify-between items-center p-3 bg-muted rounded-md">
              <span className="text-sm font-medium">총 수집 건수</span>
              <span className="font-bold">{jobStatus?.collected || 0}건</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-primary/10 text-primary rounded-md">
              <span className="text-sm font-medium">중복 제외 신규 기사</span>
              <span className="font-bold">{(jobStatus?.collected || 0) - (jobStatus?.duplicates || 0)}건</span>
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
