import React, { useState, useCallback, useEffect } from "react";
import {
  useListArticles,
  getListArticlesQueryKey,
  useUpdateArticle,
  useDeleteArticle,
  useCreateArticle,
  useGetStatYears,
  getGetStatYearsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ADMIN_REQUIRED_MESSAGE, ensureAuthorized } from "@/lib/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Plus, ChevronLeft, ChevronRight, Loader2, ExternalLink, Download } from "lucide-react";

const MONTHS = ["전체", "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
const PAGE_SIZE = 20;

function getPreview(content: string, title: string): string {
  const text = content?.trim() || "";
  if (!text) return "";
  const idx = text.indexOf("노들");
  if (idx !== -1) {
    const start = Math.max(0, idx - 12);
    const end = Math.min(text.length, idx + 60);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }
  return text.slice(0, 80) + (text.length > 80 ? "…" : "");
}

export default function Articles() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const initialFilters = new URLSearchParams(window.location.search);
  const initialYear = Number(initialFilters.get("year"));
  const initialMonth = Number(initialFilters.get("month"));
  const currentYearKst = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  const [year, setYear] = useState<number | undefined>(initialYear >= 1900 && initialYear <= 2200 ? initialYear : currentYearKst);
  const [month, setMonth] = useState<number | undefined>(initialMonth >= 1 && initialMonth <= 12 ? initialMonth : undefined);
  const [keyword, setKeyword] = useState(initialFilters.get("keyword") || "");
  const [filterNegative, setFilterNegative] = useState<boolean | undefined>(undefined);
  const [filterSelfPR, setFilterSelfPR] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const today = new Date().toISOString().split("T")[0]!;
  const firstOfYear = `${new Date().getFullYear()}-01-01`;
  const [exportStart, setExportStart] = useState(firstOfYear);
  const [exportEnd, setExportEnd] = useState(today);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportStart) params.set("startDate", exportStart);
      if (exportEnd) params.set("endDate", exportEnd);
      const res = await fetch(`/api/articles/export?${params.toString()}`);
      ensureAuthorized(res);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("content-disposition") ?? "";
      const match = cd.match(/filename\*=UTF-8''(.+)/);
      a.download = match ? decodeURIComponent(match[1]!) : "노들섬_언론보도.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({ title: "다운로드 실패", description: error instanceof Error && error.message === ADMIN_REQUIRED_MESSAGE ? error.message : undefined, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

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
  const createArticle = useCreateArticle();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListArticlesQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  }, [queryClient]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, year, month, keyword, filterNegative, filterSelfPR]);

  useEffect(() => { setPage(1); }, [year, month, keyword, filterNegative, filterSelfPR]);

  const handleToggle = (id: number, field: "isNegative" | "isSelfPR", val: boolean) => {
    updateArticle.mutate(
      { id, data: { [field]: val } },
      { onSuccess: invalidate, onError: () => toast({ title: "업데이트 실패", variant: "destructive" }) },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("이 기사를 휴지통으로 이동하시겠습니까?")) return;
    deleteArticle.mutate(
      { id },
      {
        onSuccess: () => { toast({ title: "휴지통으로 이동했습니다" }); invalidate(); },
        onError: () => toast({ title: "휴지통 이동 실패", variant: "destructive" }),
      },
    );
  };

  const visibleIds = data?.data?.map((article) => article.id) ?? [];
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  const toggleSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleIds.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0 || !confirm(`선택한 ${ids.length}건의 기사를 휴지통으로 이동하시겠습니까?`)) return;

    setIsBulkDeleting(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteArticle.mutateAsync({ id })));
      const failedCount = results.filter((result) => result.status === "rejected").length;
      const deletedCount = ids.length - failedCount;

      setSelectedIds(new Set());
      invalidate();
      if (failedCount > 0) {
        toast({
          title: "일괄 삭제 일부 실패",
          description: `${deletedCount}건 이동 완료 · ${failedCount}건 이동 실패`,
          variant: "destructive",
        });
      } else {
        toast({ title: "일괄 휴지통 이동 완료", description: `${deletedCount}건의 기사가 휴지통으로 이동했습니다.` });
      }
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const applyFilters = () => { setPage(1); refetch(); };
  const resetFilters = () => {
    setYear(undefined); setMonth(undefined); setKeyword("");
    setFilterNegative(undefined); setFilterSelfPR(undefined); setPage(1);
  };

  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">기사 목록</h2>
          <p className="text-sm text-muted-foreground mt-0.5">수집된 노들섬 관련 기사 전체</p>
        </div>
        <Button size="sm" onClick={() => setShowAddModal(true)}>
          <Plus className="w-4 h-4 mr-2" /> 수기 추가
        </Button>
      </div>

      {/* Excel Export */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">시작일</Label>
              <Input
                type="date"
                className="h-8 w-40"
                value={exportStart}
                onChange={(e) => setExportStart(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">종료일</Label>
              <Input
                type="date"
                className="h-8 w-40"
                value={exportEnd}
                onChange={(e) => setExportEnd(e.target.value)}
              />
            </div>
            <Button size="sm" className="h-8 gap-1.5" onClick={handleExport} disabled={exporting}>
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Excel 다운로드
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Filter Bar */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">연도</Label>
              <Select value={year?.toString() ?? "all"} onValueChange={(v) => setYear(v === "all" ? undefined : Number(v))}>
                <SelectTrigger className="w-24 h-8">
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
                <SelectTrigger className="w-20 h-8">
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
                className="h-8 w-44"
                placeholder="제목·본문·언론사명..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">부정</Label>
              <Select value={filterNegative == null ? "all" : filterNegative.toString()} onValueChange={(v) => setFilterNegative(v === "all" ? undefined : v === "true")}>
                <SelectTrigger className="w-20 h-8">
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
                <SelectTrigger className="w-20 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  <SelectItem value="true">예</SelectItem>
                  <SelectItem value="false">아니오</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button size="sm" className="h-8" onClick={applyFilters}>검색</Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={resetFilters}>초기화</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 px-5 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground font-normal">
              총 <span className="font-bold text-foreground">{data?.total ?? 0}</span>건
            </CardTitle>
            {selectedVisibleCount > 0 && (
              <Button
                size="sm"
                variant="destructive"
                className="h-8 gap-1.5"
                onClick={handleBulkDelete}
                disabled={isBulkDeleting}
              >
                {isBulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {isBulkDeleting ? "삭제 중..." : `선택 삭제 (${selectedVisibleCount})`}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="px-4 py-2.5 text-center font-medium w-12">
                      <Checkbox
                        aria-label="현재 페이지 기사 전체 선택"
                        checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => toggleSelectAllVisible(checked === true)}
                        disabled={visibleIds.length === 0 || isBulkDeleting}
                      />
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">게시일</th>
                    <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">매체명</th>
                    <th className="px-4 py-2.5 text-left font-medium">제목 / 미리보기</th>
                    <th className="px-4 py-2.5 text-center font-medium whitespace-nowrap">부정</th>
                    <th className="px-4 py-2.5 text-center font-medium whitespace-nowrap">자체</th>
                    <th className="px-4 py-2.5 text-center font-medium whitespace-nowrap">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.data?.map((article) => {
                    const preview = getPreview(article.content, article.title);
                    return (
                      <tr key={article.id} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2.5 text-center">
                          <Checkbox
                            aria-label={`${article.title} 선택`}
                            checked={selectedIds.has(article.id)}
                            onCheckedChange={(checked) => toggleSelected(article.id, checked === true)}
                            disabled={isBulkDeleting}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(article.publishedAt).toLocaleDateString("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit" })}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className="text-xs font-medium max-w-[90px] block truncate" title={article.mediaName}>
                            {article.mediaName}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 max-w-0 w-full">
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary font-medium text-[13px] line-clamp-1 transition-colors flex items-center gap-1 group"
                          >
                            <span className="truncate">{article.title}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
                          </a>
                          {preview && (
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                              {preview}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <Switch
                            checked={article.isNegative}
                            onCheckedChange={(v) => handleToggle(article.id, "isNegative", v)}
                            className="data-[state=checked]:bg-destructive"
                          />
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <Switch
                            checked={article.isSelfPR}
                            onCheckedChange={(v) => handleToggle(article.id, "isSelfPR", v)}
                            className="data-[state=checked]:bg-teal-600"
                          />
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => handleDelete(article.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
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

        {totalPages > 1 && (
          <div className="px-4 py-3 border-t flex items-center justify-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {computePages(page, totalPages).map((p, i) =>
              p == null ? (
                <span key={`e-${i}`} className="px-1 text-muted-foreground">…</span>
              ) : (
                <Button key={p} size="sm" variant={p === page ? "default" : "ghost"} className="h-8 w-8 p-0" onClick={() => setPage(p)}>
                  {p}
                </Button>
              )
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
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
  open, onClose, onCreate, isPending,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (v: { title: string; content: string; url: string; publishedAt: string; mediaName: string; isNegative: boolean; isSelfPR: boolean }) => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [publishedAt, setPublishedAt] = useState(new Date().toISOString().split("T")[0]);
  const [mediaName, setMediaName] = useState("");
  const [isNegative, setIsNegative] = useState(false);
  const [isSelfPR, setIsSelfPR] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>수기 기사 추가</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label>제목 *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>내용 / 요약</Label>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1">
            <Label>URL *</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>게시일</Label>
              <Input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>매체명 *</Label>
              <Input value={mediaName} onChange={(e) => setMediaName(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-6 pt-1">
            <div className="flex items-center gap-2">
              <Checkbox id="neg" checked={isNegative} onCheckedChange={(v) => setIsNegative(!!v)} />
              <Label htmlFor="neg" className="cursor-pointer">부정 기사</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="spr" checked={isSelfPR} onCheckedChange={(v) => setIsSelfPR(!!v)} />
              <Label htmlFor="spr" className="cursor-pointer">자체보도자료</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button onClick={() => onCreate({ title, content, url, publishedAt, mediaName, isNegative, isSelfPR })} disabled={!title || !url || !mediaName || isPending}>
            {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}추가
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
