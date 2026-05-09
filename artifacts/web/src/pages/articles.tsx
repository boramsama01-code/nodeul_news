import React, { useState, useCallback } from "react";
import {
  useListArticles,
  getListArticlesQueryKey,
  useUpdateArticle,
  useDeleteArticle,
  useAnalyzeArticle,
  useCreateArticle,
  useGetStatYears,
  getGetStatYearsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Trash2, BrainCircuit, Plus, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const MONTHS = ["전체", "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
const PAGE_SIZE = 20;

export default function Articles() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [year, setYear] = useState<number | undefined>(undefined);
  const [month, setMonth] = useState<number | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
  const [filterNegative, setFilterNegative] = useState<boolean | undefined>(undefined);
  const [filterSelfPR, setFilterSelfPR] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);

  const { data: yearsData } = useGetStatYears({
    query: { queryKey: getGetStatYearsQueryKey() },
  });

  const queryParams = {
    ...(year != null && { year }),
    ...(month != null && { month }),
    ...(keyword.trim() && { keyword: keyword.trim() }),
    ...(filterNegative != null && { isNegative: filterNegative }),
    ...(filterSelfPR != null && { isSelfPR: filterSelfPR }),
    page,
    limit: PAGE_SIZE,
  };

  const { data, isLoading, refetch } = useListArticles(queryParams, {
    query: { queryKey: getListArticlesQueryKey(queryParams) },
  });

  const updateArticle = useUpdateArticle();
  const deleteArticle = useDeleteArticle();
  const analyzeArticle = useAnalyzeArticle();
  const createArticle = useCreateArticle();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListArticlesQueryKey() });
  }, [queryClient]);

  const handleToggle = (id: number, field: "isNegative" | "isSelfPR", val: boolean) => {
    updateArticle.mutate(
      { id, data: { [field]: val } },
      { onSuccess: invalidate, onError: () => toast({ title: "업데이트 실패", variant: "destructive" }) },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("이 기사를 삭제하시겠습니까?")) return;
    deleteArticle.mutate(
      { id },
      {
        onSuccess: () => { toast({ title: "삭제되었습니다" }); invalidate(); },
        onError: () => toast({ title: "삭제 실패", variant: "destructive" }),
      },
    );
  };

  const handleAnalyze = async (id: number) => {
    setAnalyzingIds((s) => new Set(s).add(id));
    analyzeArticle.mutate(
      { id },
      {
        onSuccess: () => { invalidate(); },
        onError: () => toast({ title: "AI 분석 실패", variant: "destructive" }),
        onSettled: () => setAnalyzingIds((s) => { const n = new Set(s); n.delete(id); return n; }),
      },
    );
  };

  const handleBulkAnalyze = async () => {
    if (!data?.data) return;
    setBulkAnalyzing(true);
    const articles = data.data;
    const batchSize = 5;

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      const ids = batch.map((a) => a.id);
      setAnalyzingIds((s) => { const n = new Set(s); ids.forEach((id) => n.add(id)); return n; });
      await Promise.allSettled(
        batch.map((a) =>
          new Promise<void>((resolve) => {
            analyzeArticle.mutate({ id: a.id }, { onSettled: () => resolve() });
          }),
        ),
      );
      setAnalyzingIds((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n; });
      if (i + batchSize < articles.length) await sleep(1000);
    }

    setBulkAnalyzing(false);
    invalidate();
    toast({ title: "전체 AI 분석 완료" });
  };

  const applyFilters = () => { setPage(1); refetch(); };
  const resetFilters = () => {
    setYear(undefined); setMonth(undefined); setKeyword("");
    setFilterNegative(undefined); setFilterSelfPR(undefined); setPage(1);
  };

  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold tracking-tight">기사 목록</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkAnalyze}
            disabled={bulkAnalyzing || isLoading || !data?.data?.length}
            data-testid="button-bulk-analyze"
          >
            {bulkAnalyzing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <BrainCircuit className="w-4 h-4 mr-2" />}
            전체 AI 분석
          </Button>
          <Button size="sm" onClick={() => setShowAddModal(true)} data-testid="button-add-article">
            <Plus className="w-4 h-4 mr-2" /> 수기 추가
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">연도</Label>
              <Select value={year?.toString() ?? "all"} onValueChange={(v) => setYear(v === "all" ? undefined : Number(v))}>
                <SelectTrigger className="w-24 h-8" data-testid="select-year">
                  <SelectValue placeholder="전체" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  {yearsData?.years.map((y) => (
                    <SelectItem key={y} value={y.toString()}>{y}년</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">월</Label>
              <Select value={month?.toString() ?? "all"} onValueChange={(v) => setMonth(v === "all" ? undefined : Number(v))}>
                <SelectTrigger className="w-20 h-8" data-testid="select-month">
                  <SelectValue placeholder="전체" />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={i} value={i === 0 ? "all" : i.toString()}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">키워드</Label>
              <Input
                className="h-8 w-48"
                placeholder="제목 또는 매체명..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                data-testid="input-keyword"
              />
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">부정</Label>
              <Select value={filterNegative == null ? "all" : filterNegative.toString()} onValueChange={(v) => setFilterNegative(v === "all" ? undefined : v === "true")}>
                <SelectTrigger className="w-20 h-8" data-testid="select-negative">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  <SelectItem value="true">예</SelectItem>
                  <SelectItem value="false">아니오</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">자체보도</Label>
              <Select value={filterSelfPR == null ? "all" : filterSelfPR.toString()} onValueChange={(v) => setFilterSelfPR(v === "all" ? undefined : v === "true")}>
                <SelectTrigger className="w-20 h-8" data-testid="select-selfpr">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  <SelectItem value="true">예</SelectItem>
                  <SelectItem value="false">아니오</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button size="sm" className="h-8" onClick={applyFilters} data-testid="button-search">검색</Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={resetFilters}>초기화</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 px-6 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground font-normal">
              총 <span className="font-bold text-foreground">{data?.total ?? 0}</span>건
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium whitespace-nowrap">게시일</th>
                    <th className="px-4 py-2 text-left font-medium whitespace-nowrap">매체명</th>
                    <th className="px-4 py-2 text-left font-medium w-full">제목</th>
                    <th className="px-4 py-2 text-center font-medium whitespace-nowrap">부정</th>
                    <th className="px-4 py-2 text-center font-medium whitespace-nowrap">자체보도자료</th>
                    <th className="px-4 py-2 text-center font-medium whitespace-nowrap">AI</th>
                    <th className="px-4 py-2 text-center font-medium whitespace-nowrap">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.data?.map((article) => (
                    <tr key={article.id} className="border-b hover:bg-muted/20 transition-colors" data-testid={`row-article-${article.id}`}>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(article.publishedAt).toLocaleDateString("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit" })}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap max-w-[100px] truncate">{article.mediaName}</td>
                      <td className="px-4 py-2">
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline line-clamp-1 text-foreground"
                          data-testid={`link-article-${article.id}`}
                        >
                          {article.title}
                        </a>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          checked={article.isNegative}
                          onCheckedChange={(v) => handleToggle(article.id, "isNegative", v)}
                          data-testid={`switch-negative-${article.id}`}
                          className="data-[state=checked]:bg-destructive"
                        />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          checked={article.isSelfPR}
                          onCheckedChange={(v) => handleToggle(article.id, "isSelfPR", v)}
                          data-testid={`switch-selfpr-${article.id}`}
                          className="data-[state=checked]:bg-chart-4"
                        />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => handleAnalyze(article.id)}
                          disabled={analyzingIds.has(article.id)}
                          data-testid={`button-analyze-${article.id}`}
                        >
                          {analyzingIds.has(article.id) ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <BrainCircuit className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(article.id)}
                          data-testid={`button-delete-${article.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!data?.data || data.data.length === 0) && (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                        기사가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t flex items-center justify-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = computePages(page, totalPages)[i];
              return p == null ? (
                <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground">…</span>
              ) : (
                <Button
                  key={p}
                  size="sm"
                  variant={p === page ? "default" : "ghost"}
                  className="h-8 w-8 p-0"
                  onClick={() => setPage(p)}
                  data-testid={`button-page-${p}`}
                >
                  {p}
                </Button>
              );
            })}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              data-testid="button-next-page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </Card>

      <AddArticleModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreate={(values) => {
          createArticle.mutate(
            { data: values },
            {
              onSuccess: () => { toast({ title: "기사가 추가되었습니다" }); setShowAddModal(false); invalidate(); },
              onError: () => toast({ title: "추가 실패", variant: "destructive" }),
            },
          );
        }}
        isPending={createArticle.isPending}
      />
    </div>
  );
}

function AddArticleModal({
  open,
  onClose,
  onCreate,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (v: {
    title: string;
    content: string;
    url: string;
    publishedAt: string;
    mediaName: string;
    isNegative: boolean;
    isSelfPR: boolean;
  }) => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [publishedAt, setPublishedAt] = useState(new Date().toISOString().split("T")[0]);
  const [mediaName, setMediaName] = useState("");
  const [isNegative, setIsNegative] = useState(false);
  const [isSelfPR, setIsSelfPR] = useState(false);

  const handleSubmit = () => {
    if (!title || !url || !mediaName) return;
    onCreate({ title, content, url, publishedAt, mediaName, isNegative, isSelfPR });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>수기 기사 추가</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label>제목 *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="input-add-title" />
          </div>
          <div className="space-y-1">
            <Label>내용</Label>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} data-testid="input-add-content" />
          </div>
          <div className="space-y-1">
            <Label>URL *</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} data-testid="input-add-url" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>게시일</Label>
              <Input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} data-testid="input-add-date" />
            </div>
            <div className="space-y-1">
              <Label>매체명 *</Label>
              <Input value={mediaName} onChange={(e) => setMediaName(e.target.value)} data-testid="input-add-media" />
            </div>
          </div>
          <div className="flex gap-6 pt-1">
            <div className="flex items-center gap-2">
              <Checkbox id="neg" checked={isNegative} onCheckedChange={(v) => setIsNegative(!!v)} data-testid="check-add-negative" />
              <Label htmlFor="neg" className="cursor-pointer">부정 기사</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="spr" checked={isSelfPR} onCheckedChange={(v) => setIsSelfPR(!!v)} data-testid="check-add-selfpr" />
              <Label htmlFor="spr" className="cursor-pointer">자체보도자료</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button onClick={handleSubmit} disabled={!title || !url || !mediaName || isPending} data-testid="button-add-submit">
            {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            추가
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computePages(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, null, total];
  if (current >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
  return [1, null, current - 1, current, current + 1, null, total];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
