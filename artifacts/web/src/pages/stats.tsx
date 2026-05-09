import React, { useState } from "react";
import {
  useGetMonthlyStats,
  getGetMonthlyStatsQueryKey,
  useGetStatYears,
  getGetStatYearsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const MONTH_LABELS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];

export default function Stats() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [startDate, setStartDate] = useState(
    `${currentYear}-01-01`,
  );
  const [endDate, setEndDate] = useState(
    new Date().toISOString().split("T")[0],
  );

  const { data: yearsData } = useGetStatYears({
    query: { queryKey: getGetStatYearsQueryKey() },
  });

  const { data: yearlyStats, isLoading: loadingYearly } = useGetMonthlyStats(
    { year: selectedYear },
    { query: { queryKey: getGetMonthlyStatsQueryKey({ year: selectedYear }) } },
  );

  const { data: rangeStats, isLoading: loadingRange } = useGetMonthlyStats(
    { startDate, endDate },
    { query: { queryKey: getGetMonthlyStatsQueryKey({ startDate, endDate }) } },
  );

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">통계</h2>

      <Tabs defaultValue="yearly">
        <TabsList>
          <TabsTrigger value="yearly" data-testid="tab-yearly">연도별</TabsTrigger>
          <TabsTrigger value="range" data-testid="tab-range">기간별</TabsTrigger>
        </TabsList>

        <TabsContent value="yearly" className="space-y-6 mt-4">
          <div className="flex items-center gap-3">
            <Label>연도</Label>
            <Select
              value={selectedYear.toString()}
              onValueChange={(v) => setSelectedYear(Number(v))}
            >
              <SelectTrigger className="w-28" data-testid="select-stats-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(yearsData?.years ?? [currentYear]).map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}년
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <StatsDisplay stats={yearlyStats} isLoading={loadingYearly} />
        </TabsContent>

        <TabsContent value="range" className="space-y-6 mt-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap">시작일</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
                data-testid="input-stats-start"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap">종료일</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
                data-testid="input-stats-end"
              />
            </div>
          </div>
          <StatsDisplay stats={rangeStats} isLoading={loadingRange} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type MonthlyStat = {
  month: number;
  total: number;
  negative: number;
  statistical: number;
  selfPR: number;
};

function StatsDisplay({
  stats,
  isLoading,
}: {
  stats?: MonthlyStat[];
  isLoading: boolean;
}) {
  const safeStats = stats ?? [];

  const totals = safeStats.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      negative: acc.negative + s.negative,
      statistical: acc.statistical + s.statistical,
      selfPR: acc.selfPR + s.selfPR,
    }),
    { total: 0, negative: 0, statistical: 0, selfPR: 0 },
  );

  const chartData = safeStats.map((s) => ({
    ...s,
    name: `${s.month}월`,
  }));

  return (
    <div className="space-y-6">
      {/* Highlight card */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <HighlightCard label="전체" value={totals.total} color="chart-1" />
        <HighlightCard label="부정기사" value={totals.negative} color="chart-2" />
        <HighlightCard label="통계보도건수" value={totals.statistical} color="chart-3" note="전체 - 부정" />
        <HighlightCard label="자체보도자료" value={totals.selfPR} color="chart-4" />
      </div>

      {/* Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">월별 보도 현황</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-80 w-full" />
          ) : (
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "4px",
                      border: "1px solid hsl(var(--border))",
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="total" name="전체" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="negative" name="부정" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="statistical" name="통계보도건수" fill="hsl(var(--chart-3))" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="selfPR" name="자체보도자료" fill="hsl(var(--chart-4))" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="py-3 px-6 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">월별 상세 통계</CardTitle>
            <span className="text-xs text-muted-foreground">통계보도건수 = 전체 - 부정</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-right">
                    <th className="px-5 py-2 text-left font-medium">월</th>
                    <th className="px-5 py-2 font-medium">전체</th>
                    <th className="px-5 py-2 font-medium">부정</th>
                    <th className="px-5 py-2 font-medium">통계보도건수</th>
                    <th className="px-5 py-2 font-medium">자체보도자료</th>
                  </tr>
                </thead>
                <tbody>
                  {MONTH_LABELS.map((label, i) => {
                    const s = safeStats.find((r) => r.month === i + 1) ?? {
                      month: i + 1, total: 0, negative: 0, statistical: 0, selfPR: 0,
                    };
                    return (
                      <tr key={i} className="border-b hover:bg-muted/20 transition-colors text-right">
                        <td className="px-5 py-2 text-left font-medium">{label}</td>
                        <td className="px-5 py-2">{s.total.toLocaleString()}</td>
                        <td className="px-5 py-2 text-destructive">{s.negative.toLocaleString()}</td>
                        <td className="px-5 py-2 text-chart-3">{s.statistical.toLocaleString()}</td>
                        <td className="px-5 py-2 text-chart-4">{s.selfPR.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                  {/* Total row */}
                  <tr className="bg-muted/30 font-semibold text-right border-t-2">
                    <td className="px-5 py-2 text-left">합계</td>
                    <td className="px-5 py-2">{totals.total.toLocaleString()}</td>
                    <td className="px-5 py-2 text-destructive">{totals.negative.toLocaleString()}</td>
                    <td className="px-5 py-2 text-chart-3">{totals.statistical.toLocaleString()}</td>
                    <td className="px-5 py-2 text-chart-4">{totals.selfPR.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HighlightCard({
  label,
  value,
  color,
  note,
}: {
  label: string;
  value: number;
  color: string;
  note?: string;
}) {
  return (
    <Card className={`border-${color}/30 bg-${color}/5`}>
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center justify-between">
          {label}
          {note && <span className="text-[10px] text-muted-foreground/60">{note}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 px-4">
        <div className={`text-2xl font-bold text-${color}`}>{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}
