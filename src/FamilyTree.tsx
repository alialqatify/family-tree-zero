import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Tree, { RawNodeDatum, CustomNodeElementProps } from 'react-d3-tree';
import { hierarchy, tree as d3tree } from 'd3-hierarchy';
import { Loader2, AlertCircle, Search, ArrowRight, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface Person {
  id: string;
  full_name: string | null;
  family_title: string | null;
  father_id: string | null;
  life_status: 'حي' | 'متوفى' | 'شهيد' | null;
}

interface TreeNode extends RawNodeDatum {
  name: string;
  attributes: { id: string; title: string; status: string };
  children: TreeNode[];
}

type LoadState = 'loading' | 'success' | 'empty' | 'error';

const NODE_SIZE = { x: 220, y: 140 };
const SEPARATION = { siblings: 1.5, nonSiblings: 2 };
const DEPTH_FACTOR = -180; // negative = tree grows upward (root at bottom)

function findPath(roots: TreeNode[], targetId: string): string[] | null {
  const dfs = (node: TreeNode, path: string[]): string[] | null => {
    if (node.attributes.id === targetId) return [...path, node.attributes.id];
    for (const child of node.children) {
      const r = dfs(child, [...path, node.attributes.id]);
      if (r) return r;
    }
    return null;
  };
  for (const root of roots) {
    const r = dfs(root, []);
    if (r) return r;
  }
  return null;
}

function buildVisibleData(roots: TreeNode[], collapsedIds: Set<string>): TreeNode[] {
  const clone = (node: TreeNode): TreeNode => ({
    ...node,
    attributes: { ...node.attributes },
    children: collapsedIds.has(node.attributes.id) ? [] : node.children.map(clone),
  });
  return roots.map(clone);
}

function computeNodePosition(rootData: TreeNode, targetId: string): { x: number; y: number } | null {
  const layout = d3tree<TreeNode>()
    .nodeSize([NODE_SIZE.x, NODE_SIZE.y])
    .separation((a, b) => (a.parent === b.parent ? SEPARATION.siblings : SEPARATION.nonSiblings));
  const root = hierarchy<TreeNode>(rootData, d => d.children);
  layout(root);
  root.descendants().forEach(n => { n.y = n.depth * DEPTH_FACTOR; });
  const target = root.descendants().find(n => n.data.attributes?.id === targetId);
  return target && target.x != null && target.y != null ? { x: target.x, y: target.y } : null;
}

export default function FamilyTree() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMessage, setSearchMessage] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [modalPerson, setModalPerson] = useState<{ name: string; title: string; status: string } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [treeKey, setTreeKey] = useState('tree-initial');

  const containerRef = useRef<HTMLDivElement>(null);
  const currentZoomRef = useRef(1);

  useEffect(() => {
    const fetchData = async () => {
      setLoadState('loading');
      const { data, error } = await supabase
        .from('people')
        .select('id, full_name, family_title, father_id, life_status')
        .eq('gender', 'male');
      if (error) { setErrorMsg(error.message); setLoadState('error'); return; }
      if (!data || data.length === 0) { setLoadState('empty'); return; }

      const nodes = data as Person[];
      const nodeMap = new Map<string, TreeNode>();
      for (const p of nodes) {
        nodeMap.set(p.id, {
          name: p.full_name || '—',
          attributes: { id: p.id, title: p.family_title || '', status: p.life_status || '' },
          children: [],
        });
      }
      const roots: TreeNode[] = [];
      for (const p of nodes) {
        const node = nodeMap.get(p.id)!;
        if (p.father_id && nodeMap.has(p.father_id)) {
          nodeMap.get(p.father_id)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
      if (roots.length === 0) { setLoadState('empty'); return; }
      setTreeData(roots);
      setLoadState('success');
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateDims = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
      if (treeKey === 'tree-initial') {
        setTranslate({ x: rect.width / 2, y: rect.height - 80 });
      }
    };
    updateDims();
    window.addEventListener('resize', updateDims);
    return () => window.removeEventListener('resize', updateDims);
  }, [loadState, treeKey]);

  useEffect(() => {
    if (!modalPerson) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setModalPerson(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalPerson]);

  const allNodes = useMemo(() => {
    const flat: { id: string; name: string }[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        flat.push({ id: n.attributes.id, name: n.name });
        if (n.children.length) walk(n.children);
      }
    };
    walk(treeData);
    return flat;
  }, [treeData]);

  const nodesWithChildren = useMemo(() => {
    const set = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) set.add(n.attributes.id);
        walk(n.children);
      }
    };
    walk(treeData);
    return set;
  }, [treeData]);

  const visibleData = useMemo(
    () => buildVisibleData(treeData, collapsedIds),
    [treeData, collapsedIds],
  );

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleSearch = useCallback(() => {
    const term = searchTerm.trim();
    if (!term || treeData.length === 0) { setSearchMessage('لم يُعثر على الاسم'); return; }

    const match = allNodes.find(n => n.name.toLowerCase().includes(term.toLowerCase()));
    if (!match) { setSearchMessage('لم يُعثر على الاسم'); return; }

    const path = findPath(treeData, match.id);
    if (!path) { setSearchMessage('لم يُعثر على الاسم'); return; }

    const newCollapsedIds = new Set(collapsedIds);
    for (const id of path) newCollapsedIds.delete(id);

    const expandedData = buildVisibleData(treeData, newCollapsedIds);
    const targetPos = expandedData.length > 0 ? computeNodePosition(expandedData[0], match.id) : null;

    setSearchMessage('');
    setHighlightId(match.id);
    setCollapsedIds(newCollapsedIds);

    if (targetPos && dimensions.width > 0) {
      const z = currentZoomRef.current;
      setTranslate({
        x: dimensions.width / 2 - targetPos.x * z,
        y: dimensions.height / 2 - targetPos.y * z,
      });
      setZoom(z);
      setTreeKey(`tree-${match.id}-${Date.now()}`);
    }
  }, [searchTerm, allNodes, treeData, collapsedIds, dimensions]);

  const handleUpdate = useCallback((state: { zoom: number }) => {
    currentZoomRef.current = state.zoom;
  }, []);

  const renderNode = useCallback((props: CustomNodeElementProps) => {
    const { nodeDatum } = props;
    const id = nodeDatum.attributes?.id as string;
    const title = nodeDatum.attributes?.title as string | undefined;
    const status = nodeDatum.attributes?.status as string | undefined;
    const isDeceased = status === 'متوفى' || status === 'شهيد';
    const hasChildren = nodesWithChildren.has(id);
    const isCollapsed = hasChildren && (nodeDatum.children?.length ?? 0) === 0;
    const isHighlighted = highlightId === id;

    const handlePointerDown = (e: React.PointerEvent) => {
      e.currentTarget.setAttribute('data-dx', String(e.clientX));
      e.currentTarget.setAttribute('data-dy', String(e.clientY));
    };

    const handlePointerUp = (e: React.PointerEvent) => {
      const dx = parseFloat(e.currentTarget.getAttribute('data-dx') || '0');
      const dy = parseFloat(e.currentTarget.getAttribute('data-dy') || '0');
      if (Math.sqrt((e.clientX - dx) ** 2 + (e.clientY - dy) ** 2) > 10) return;

      const isArrow = (e.target as SVGElement).getAttribute('data-arrow') === 'true';
      if (isArrow && hasChildren) {
        toggleCollapse(id);
      } else {
        setModalPerson({ name: nodeDatum.name, title: title || '', status: status || '' });
      }
    };

    const nameW = nodeDatum.name.length * 9 + (isDeceased ? 60 : 0) + 24;
    const rectW = Math.max(nameW, title ? title.length * 8 + 24 : 80);
    const rectH = title ? 44 : 28;

    return (
      <g
        data-person-id={id}
        style={{ cursor: 'pointer' }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onClick={(e) => e.stopPropagation()}
      >
        {isHighlighted && (
          <rect
            x={-rectW / 2 - 6}
            y={-rectH / 2 - 6}
            width={rectW + 12}
            height={rectH + 12}
            rx={10}
            fill="#fef08a"
            stroke="#eab308"
            strokeWidth={3}
          />
        )}
        <rect
          x={-rectW / 2}
          y={-rectH / 2}
          width={rectW}
          height={rectH}
          rx={6}
          fill="#f8fafc"
          stroke="#cbd5e1"
          strokeWidth={1}
        />
        <text
          x="0"
          y={title ? -6 : 4}
          textAnchor="middle"
          fill="#1e293b"
          fontSize="16"
          fontWeight="600"
          style={{ fontFamily: 'Cairo, sans-serif' }}
        >
          {nodeDatum.name}
          {isDeceased && (
            <tspan fill="#64748b" fontSize="13" dx="4" fontWeight="400">(رحمه الله)</tspan>
          )}
        </text>
        {title && (
          <text x="0" y="14" textAnchor="middle" fill="#64748b" fontSize="12" style={{ fontFamily: 'Cairo, sans-serif' }}>
            {title}
          </text>
        )}
        {hasChildren && (
          <g data-arrow="true" transform={`translate(${rectW / 2 + 8}, 0)`}>
            <circle r={10} fill="#1e40af" data-arrow="true" />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fontSize="12"
              fontWeight="700"
              data-arrow="true"
              style={{ fontFamily: 'sans-serif' }}
            >
              {isCollapsed ? '▶' : '▼'}
            </text>
          </g>
        )}
      </g>
    );
  }, [highlightId, nodesWithChildren, toggleCollapse]);

  if (loadState === 'loading') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-sm text-slate-600">جاري تحميل بيانات الشجرة…</p>
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4">
        <AlertCircle className="w-8 h-8 text-red-600" />
        <p className="text-sm text-red-700 text-center max-w-md">فشل تحميل البيانات: {errorMsg}</p>
        <a href="#/" className="text-sm text-blue-600 underline mt-2">العودة للوحة التحكم</a>
      </div>
    );
  }
  if (loadState === 'empty') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4">
        <AlertCircle className="w-8 h-8 text-amber-500" />
        <p className="text-sm text-slate-600 text-center max-w-md">لا توجد بيانات ذكور في قاعدة البيانات لعرض الشجرة.</p>
        <a href="#/" className="text-sm text-blue-600 underline mt-2">العودة للوحة التحكم</a>
      </div>
    );
  }

  return (
    <div dir="rtl" className="flex flex-col h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 flex-wrap shrink-0">
        <a href="#/" className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 shrink-0">
          <ArrowRight className="w-4 h-4" />
          لوحة التحكم
        </a>
        <h1 className="text-base font-bold text-slate-800 shrink-0">شجرة العائلة</h1>
        <div className="flex items-center gap-2 mr-auto">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="بحث بالاسم…"
              className="pr-8 pl-3 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 w-48"
            />
          </div>
          <button
            onClick={handleSearch}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            بحث
          </button>
        </div>
      </div>

      {searchMessage && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-700 text-center shrink-0">
          {searchMessage}
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        onClick={() => setHighlightId(null)}
      >
        {dimensions.width > 0 && visibleData.length > 0 && (
          <Tree
            key={treeKey}
            data={visibleData}
            orientation="vertical"
            pathFunc="diagonal"
            collapsible={false}
            depthFactor={DEPTH_FACTOR}
            nodeSize={NODE_SIZE}
            separation={SEPARATION}
            dimensions={dimensions}
            zoomable
            scaleExtent={{ min: 0.1, max: 5 }}
            translate={translate}
            zoom={zoom}
            renderCustomNodeElement={renderNode}
            transitionDuration={300}
            onUpdate={handleUpdate}
          />
        )}
      </div>

      {modalPerson && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-lg p-6 max-w-sm w-full mx-4" dir="rtl">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">بطاقة الشخص</h2>
              <button
                onClick={() => setModalPerson(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <span className="text-slate-500 shrink-0">الاسم:</span>
                <span className="font-medium text-slate-800">{modalPerson.name}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 shrink-0">اللقب:</span>
                <span className="font-medium text-slate-800">{modalPerson.title || '—'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 shrink-0">الحالة:</span>
                <span className="font-medium text-slate-800">{modalPerson.status || '—'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
