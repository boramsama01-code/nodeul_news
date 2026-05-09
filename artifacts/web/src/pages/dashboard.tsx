import React from "react";
import { useGetStatsSummary, getGetStatsSummaryQueryKey, useGetMonthlyStats, getGetMonthlyStatsQueryKey, useGetRecentArticles, getGetRecentArticlesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const currentYear = new Date().getFullYear();

  const { data: summary, isLoading: loadingSummary } = useGetStatsSummary({
    query: {
      queryKey: getGetStatsSummaryQueryKey(),
    }
  });

  const { data: monthlyStats, isLoading: loadingMonthly } = useGetMonthlyStats(
    { year: currentYear },
    { query: { queryKey: getGetMonthlyStatsQueryKey({ year: currentYear }) } }
  );

  const { data: recentArticles, isLoading: loadingRecent } = useGetRecentArticles({
    query: { queryKey: getGetRecentArticlesQueryKey() }
  });

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">대시보드</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="전체 기사" value={summary?.totalArticles} loading={loadingSummary} />
        <StatCard title="통계 보도건수" value={summary?.statisticalCount} loading={loadingSummary} className="border-chart-3/20 bg-chart-3/5" />
        <StatCard title="자체보도자료" value={summary?.selfPRCount} loading={loadingSummary} className="border-chart-4/20 bg-chart-4/5" />
        <StatCard title="부정기사" value={summary?.negativeCount} loading={loadingSummary} className="border-chart-2/20 bg-chart-2/5" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle>{currentYear}년 월별 보도 현황</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingMonthly ? (
              <Skeleton className="w-full h-[300px]" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyStats || []}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={(value) => `${value}월`} />
                    <YAxis />
                    <Tooltip 
                      labelFormatter={(value) => `${value}월`}
                      contentStyle={{ borderRadius: '4px', border: '1px solid hsl(var(--border))' }}
                    />
                    <Bar dataKey="total" name="전체 기사" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>최근 수집된 기사</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingRecent ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="w-full h-12" />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {recentArticles?.map((article) => (
                  <div key={article.id} className="flex flex-col gap-1 border-b pb-3 last:border-0 last:pb-0">
                    <a href={article.url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline line-clamp-2">
                      {article.title}
                    </a>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{article.mediaName} • {new Date(article.publishedAt).toLocaleDateString()}</span>
                      <div className="flex gap-1">
                        {article.isNegative && <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">부정</Badge>}
                        {article.isSelfPR && <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 bg-chart-4/20 text-chart-4 hover:bg-chart-4/30">자체</Badge>}
                      </div>
                    </div>
                  </div>
                ))}
                {(!recentArticles || recentArticles.length === 0) && (
                  <div className="text-sm text-muted-foreground text-center py-4">최근 기사가 없습니다.</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ title, value, loading, className = "" }: { title: string; value?: number; loading: boolean; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="text-3xl font-bold">{value?.toLocaleString() || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
