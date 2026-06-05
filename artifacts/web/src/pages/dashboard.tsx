import React, { useState } from "react";
import {
  useGetStatsSummary, getGetStatsSummaryQueryKey,
  useGetMonthlyStats, getGetMonthlyStatsQueryKey,
  useGetRecentArticles, getGetRecentArticlesQueryKey,
  useGetStatYears, getGetStatYearsQueryKey,
  useGetTopMedia, getGetTopMediaQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Line, Legend, ComposedChart,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, Newspaper, AlertTriangle, Megaphone, BarChart2 } from "lucide-react";

function getArticlePreview(content: string, title: string): string {
  const text = content || title;
  if (!text) return "";
  const idx = text.indexOf("노들");
  if (idx !== -1) {
    const start = Math.max(0, idx - 15);
    const end = Math.min(text.length, idx + 55);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }
  return text.slice(0, 70) + (text.length > 70 ? "…" : "");
}

function YoYBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return <span className="text-xs text-muted-foreground">전년 데이터 없음</span>;
  const delta = current - previous;
  const pct = Math.round((delta / previous) * 100);
  if (pct === 0)
    return (
      <span className="text-xs text-muted-foreground flex items-center gap-0.5">
        <Minus className="w-3 h-3" />전년 대비 ±0%
      </span>
    );
  if (delta > 0)
    return (
      <span className="text-xs text-emerald-600 flex items-center gap-0.5">
        <TrendingUp className="w-3 h-3" />전년 대비 +{pct}% (+{delta.toLocaleString()}건)
      </span>
    );
  return (
    <span className="text-xs text-destructive flex items-center gap-0.5">
      <TrendingDown className="w-3 h-3" />전년 대비 {pct}% ({delta.toLocaleString()}건)
    </span>
  );
}

export default function Dashboard() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  const { data: yearsData } = useGetStatYears({
    query: { queryKey: getGetStatYearsQueryKey() },
  });

  const { data: summary, isLoading: loadingSummary } = useGetStatsSummary(
    { year: selectedYear },
    { query: { queryKey: getGetStatsSummaryQueryKey({ year: selectedYear }) } },
  );
  const { data: prevSummary } = useGetStatsSummary(
    { year: selectedYear - 1 },
    { query: { queryKey: getGetStatsSummaryQueryKey({ year: selectedYear - 1 }) } },
  );

  const { data: monthlyStats, isLoading: loadingMonthly } = useGetMonthlyStats(
    { year: selectedYear },
    { query: { queryKey: getGetMonthlyStatsQueryKey({ year: selectedYear }) } },
  );
  const { data: prevYearMonthly } = useGetMonthlyStats(
    { year: selectedYear - 1 },
    { query: { queryKey: getGetMonthlyStatsQueryKey({ year: selectedYear - 1 }) } },
  );

  const { data: topMedia, isLoading: loadingTopMedia } = useGetTopMedia(
    { year: selectedYear, limit: 10 },
    { query: { queryKey: getGetTopMediaQueryKey({ year: selectedYear, limit: 10 }) } },
  );

  const { data: recentArticles, isLoading: loadingRecent } = useGetRecentArticles({
    query: { queryKey: getGetRecentArticlesQueryKey() },
  });

  // Build chart data: bar = 올해, dashed line = 전년, hidden line = 전년대비증감
  const chartData = (monthlyStats || []).map((m) => {
    const prev = prevYearMonthly?.find((p) => p.month === m.month);
    const prevTotal = prev?.total ?? 0;
    return {
      month: m.month,
      올해: m.total,
      전년: prevTotal,
      증감: m.total - prevTotal,
      총보도: m.total,
      부정보도: m.negative,
      순보도: m.total - m.negative,
    };
  });

  const negativeRate = summary?.totalArticles
    ? Math.round((summary.negativeCount / summary.totalArticles) * 100)
    : 0;
  const prevNegativeRate = prevSummary?.totalArticles
    ? Math.round((prevSummary.negativeCount / prevSummary.totalArticles) * 100)
    : 0;

  const maxMedia = topMedia && topMedia.length > 0 ? Math.max(...topMedia.map((m) => m.count)) : 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">노들섬 언론 모니터링</h2>
          <p className="text-sm text-muted-foreground mt-0.5">언론 보도 현황 및 전년 대비 동향</p>
        </div>
        <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
          <SelectTrigger className="w-28 h-9 font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(yearsData?.years ?? [currentYear]).map((y) => (
              <SelectItem key={y} value={String(y)}>{y}년</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="총 보도 건수"
          value={summary?.totalArticles}
          prev={prevSummary?.totalArticles}
          loading={loadingSummary}
          icon={<Newspaper className="w-4 h-4" />}
          color="blue"
          sub={summary && summary.totalAllTime !== summary.totalArticles
            ? `DB 전체 누적 ${summary.totalAllTime.toLocaleString()}건`
            : undefined}
        />
        <KpiCard
          title="부정 기사"
          value={summary?.negativeCount}
          prev={prevSummary?.negativeCount}
          loading={loadingSummary}
          icon={<AlertTriangle className="w-4 h-4" />}
          color="red"
          sub={`부정 비율 ${negativeRate}%${prevSummary ? ` (전년 ${prevNegativeRate}%)` : ""}`}
        />
        <KpiCard
          title="자체보도자료"
          value={summary?.selfPRCount}
          prev={prevSummary?.selfPRCount}
          loading={loadingSummary}
          icon={<Megaphone className="w-4 h-4" />}
          color="teal"
        />
        <KpiCard
          title="통계 보도건수"
          value={summary?.statisticalCount}
          prev={prevSummary?.statisticalCount}
          loading={loadingSummary}
          icon={<BarChart2 className="w-4 h-4" />}
          color="amber"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly Trend */}
        <Card className="col-span-1 lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>연간 월별 보도 추이</span>
              <span className="text-xs font-normal text-muted-foreground">{selectedYear}년 · 총보도/부정/순보도</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingMonthly ? (
              <Skeleton className="w-full h-[280px]" />
            ) : (
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="month"
                      tickFormatter={(v) => `${v}월`}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      labelFormatter={(v) => `${v}월`}
                      formatter={(value: number, name: string) => [`${value}건`, name]}
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid hsl(var(--border))",
                        fontSize: "12px",
                        background: "hsl(var(--card))",
                      }}
                    />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }}
                    />
                    <Bar dataKey="총보도" fill="hsl(var(--foreground))" radius={[3, 3, 0, 0]} maxBarSize={36} />
                    <Bar dataKey="부정보도" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} maxBarSize={36} fillOpacity={0.85} />
                    <Line
                      type="monotone"
                      dataKey="순보도"
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={2}
                      dot={{ r: 3, fill: "hsl(var(--chart-1))" }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Media */}
        <Card className="col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">주요 보도 매체 Top 10</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            {loadingTopMedia ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
              </div>
            ) : (
              <div className="space-y-1.5">
                {(topMedia || []).slice(0, 10).map((m, i) => (
                  <div key={m.mediaName} className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[12px] font-medium truncate">{m.mediaName}</span>
                        <span className="text-[11px] text-muted-foreground ml-2 shrink-0">{m.count}건</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(m.count / maxMedia) * 100}%`,
                            background: i === 0 ? "hsl(var(--chart-1))" : i < 3 ? "hsl(var(--chart-3))" : "hsl(var(--muted-foreground))",
                            opacity: 0.7 + (i === 0 ? 0.3 : 0),
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* YoY Monthly Delta Chart */}
      {prevYearMonthly && prevYearMonthly.some((m) => m.total > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>전년 대비 월별 보도량</span>
              <span className="text-xs font-normal text-muted-foreground">{selectedYear}년 vs {selectedYear - 1}년</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingMonthly ? (
              <Skeleton className="w-full h-[160px]" />
            ) : (
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="month"
                      tickFormatter={(v) => `${v}월`}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      labelFormatter={(v) => `${v}월`}
                      formatter={(value: number, name: string) => [`${value}건`, name]}
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid hsl(var(--border))",
                        fontSize: "12px",
                        background: "hsl(var(--card))",
                      }}
                    />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} />
                    <Line
                      type="monotone"
                      dataKey="올해"
                      name={`${selectedYear}년`}
                      stroke="hsl(var(--chart-1))"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "hsl(var(--chart-1))" }}
                    />
                    <Line
                      type="monotone"
                      dataKey="전년"
                      name={`${selectedYear - 1}년`}
                      stroke="hsl(var(--chart-4))"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      dot={{ r: 3, fill: "hsl(var(--chart-4))" }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recent Articles */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">최근 수집 기사</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingRecent ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : (
            <div className="divide-y">
              {(recentArticles || []).map((article) => (
                <div key={article.id} className="px-5 py-3 hover:bg-muted/30 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium hover:text-primary line-clamp-1 transition-colors"
                      >
                        {article.title}
                      </a>
                      {article.content && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {getArticlePreview(article.content, article.title)}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <div className="flex gap-1">
                        {article.isNegative && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">부정</Badge>
                        )}
                        {article.isSelfPR && (
                          <Badge className="text-[10px] px-1.5 py-0 h-4 bg-teal-100 text-teal-700 border-teal-200">자체</Badge>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {article.mediaName} · {new Date(article.publishedAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              {(!recentArticles || recentArticles.length === 0) && (
                <div className="p-8 text-center text-sm text-muted-foreground">수집된 기사가 없습니다.</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const colorMap = {
  blue: { bg: "bg-blue-50", icon: "text-blue-600", border: "border-blue-100" },
  red: { bg: "bg-red-50", icon: "text-red-600", border: "border-red-100" },
  teal: { bg: "bg-teal-50", icon: "text-teal-600", border: "border-teal-100" },
  amber: { bg: "bg-amber-50", icon: "text-amber-600", border: "border-amber-100" },
};

function KpiCard({
  title, value, prev, loading, icon, color, sub,
}: {
  title: string;
  value?: number;
  prev?: number;
  loading: boolean;
  icon: React.ReactNode;
  color: keyof typeof colorMap;
  sub?: string;
}) {
  const c = colorMap[color];
  return (
    <Card className={`border ${c.border}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <p className="text-xs font-medium text-muted-foreground leading-tight">{title}</p>
          <div className={`w-7 h-7 rounded-md ${c.bg} flex items-center justify-center ${c.icon}`}>
            {icon}
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{(value ?? 0).toLocaleString()}</span>
              <span className="text-sm text-muted-foreground">건</span>
            </div>
            <div className="mt-1.5 space-y-0.5">
              {prev != null && <YoYBadge current={value ?? 0} previous={prev} />}
              {sub && <span className="text-[10px] text-muted-foreground block">{sub}</span>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
