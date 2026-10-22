import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Status = "related" | "unrelated" | "pending";
interface ReviewResponse {
  counts: Record<Status, number>; total: number;
  data: {title: string; url: string; source: string; mediaName: string; publishedAt: string;
    retryAt: string; delivered: boolean; decision: {status: Status; reason: string; evidence: string[]}}[];
}
const labels: Record<Status, string> = {pending: "확인 대기", related: "관련 확인", unrelated: "무관 확인"};

export function RelevanceReview({onRetry, disabled}: {onRetry: () => void; disabled: boolean}) {
  const [status, setStatus] = useState<Status>("pending");
  const [page, setPage] = useState(1);
  const {data, isError} = useQuery<ReviewResponse>({
    queryKey: ["relevance-review", status, page],
    queryFn: async () => {
      const response = await fetch(`/api/crawl/relevance?status=${status}&page=${page}`);
      if (!response.ok) throw new Error("확인 기록 조회 실패");
      return response.json();
    }, refetchInterval: disabled ? 10_000 : false,
  });
  return <Card>
    <CardHeader>
      <CardTitle>노들섬 관련성 확인</CardTitle>
      <CardDescription>새 수집 후보의 제목·요약과 필요한 원문을 확인한 기록입니다. 기존 기사 전체를 다시 분류한 건수는 아닙니다. 확인 대기와 무관 확인은 새 기사 집계에 포함하지 않습니다.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="관련성 상태">
        {(["pending", "related", "unrelated"] as const).map(value => <Button key={value} variant={status === value ? "default" : "outline"} onClick={() => {setStatus(value); setPage(1);}}>{labels[value]} {data?.counts[value] ?? "—"}</Button>)}
        <Button variant="outline" onClick={onRetry} disabled={disabled || !data}>대기 후보 재확인</Button>
      </div>
      <p className="text-sm text-muted-foreground">아래 일반 수집에 선택한 기간에서 재시도 시간이 지난 후보를 최대 80건 확인합니다. 실패한 원문은 6시간 후 재시도하며, 수집 경로·정확한 URL별 별도 집계를 유지합니다.</p>
      {isError && <p role="alert">확인 기록을 읽지 못했습니다. 서버 연결을 확인해 주세요.</p>}
      {data?.total === 0 && <p className="text-sm">{labels[status]} 기록이 없습니다.</p>}
      <div className="divide-y max-h-[420px] overflow-auto">
        {data?.data.map(row => <div key={`${row.source}\0${row.url}`} className="py-3 space-y-1">
          <a className="font-medium underline" href={row.url} target="_blank" rel="noreferrer">{row.title}</a>
          <p className="text-sm text-muted-foreground">{row.mediaName} · {new Date(row.publishedAt).toLocaleDateString("ko-KR", {timeZone: "Asia/Seoul"})}</p>
          <p className="text-sm">{row.decision.reason}</p>
          {row.decision.evidence.map((line,i) => <p key={i} className="text-sm text-muted-foreground">근거: {line}</p>)}
          {status === "pending" && <p className="text-xs text-muted-foreground">재시도 가능: {new Date(row.retryAt).toLocaleString("ko-KR", {timeZone: "Asia/Seoul"})}</p>}
          {status === "related" && !row.delivered && <p className="text-xs">기사 목록 저장 대기</p>}
        </div>)}
      </div>
      {data && data.total > 30 && <div className="flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>이전</Button><span>{page} / {Math.ceil(data.total / 30)}</span><Button variant="outline" disabled={page * 30 >= data.total} onClick={() => setPage(p => p + 1)}>다음</Button></div>}
    </CardContent>
  </Card>;
}
